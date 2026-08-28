/**
 * The kernel pairing secret AT REST (B2, ADR-0026). After a successful pairing
 * handshake the kernel writes the obtained control pairing (controlRoom +
 * responseKey) to a durable file so RE-RUNS need NO re-paste — the operator pastes
 * the one-time `--pairing-code` exactly once.
 *
 * STORAGE:
 *   `${XDG_STATE_HOME:-$HOME/.local/state}/galley/kernel/pairing.json`, overridable
 *   with `GALLEY_MCP_PAIRING_FILE` (tests/CI). The directory is created mode 0700
 *   and the file is written mode 0600 — the secret is never world/group readable.
 *
 * INTEGRITY (copy-detection, NOT confidentiality):
 *   A SEPARATE 32-byte LOCAL INTEGRITY KEY is generated ONCE at the state root
 *   (sibling `integrity.key`, mode 0600). The pairing MAC =
 *   HMAC-SHA-256(HKDF(localKey, "pairing-store"), canonical(pairing)). On load the
 *   MAC is recomputed and the pairing is REJECTED unless it matches — so copying
 *   ONLY pairing.json to another machine (whose local key differs) FAILS the MAC
 *   and the kernel falls back to args. This is v1: 0600 + MAC. AES-at-rest, an OS
 *   keychain, and per-secret encryption are deliberately CUT from v1 (ADR-0026):
 *   the file perms are the confidentiality boundary, the MAC is the tamper/copy
 *   boundary.
 *
 * FAIL CLOSED: every read path returns `null` on absent / unreadable / malformed /
 * wrong-shape / MAC-mismatch — never a throw, never a half-trusted pairing. The
 * caller (main.ts) treats `null` as "no durable pairing" and resolves the next
 * source (the `--pairing-code` handshake, or an honest error).
 *
 * Persist ONLY the control pairing — NEVER a project shareRoom / grantId as a
 * reusable kernel authority (those are per-session, consent-scoped).
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { base64UrlToBytes } from "@galley/collab";
import { isCapabilityRoomId } from "@galley/shared";

/**
 * Validate a durable pairing's SHAPE (#4) — independent of the MAC. A pairing is
 * usable ONLY when `controlRoom` is a capability room id AND `responseKey` decodes
 * to EXACTLY 32 bytes that are not all-zero. Enforced on BOTH save (refuse to write
 * garbage) and load (fail-closed before returning), so a shape-bad durable blob can
 * never reach the join path even if its MAC somehow verified.
 */
function isValidPairingShape(p: DurablePairing): boolean {
  if (!isCapabilityRoomId(p.controlRoom)) return false;
  const key = base64UrlToBytes(p.responseKey);
  if (key === null || key.length !== 32) return false;
  if (key.every((b) => b === 0)) return false;
  return true;
}

/** The control pairing the kernel persists — controlRoom + the base64url responseKey. */
export interface DurablePairing {
  controlRoom: string;
  /** base64url of the 32-byte response-auth key. */
  responseKey: string;
}

/** The on-disk blob: the pairing + when it was paired + the integrity MAC. */
interface StoredPairing extends DurablePairing {
  pairedAt: number;
  /** base64url HMAC over the canonical pairing — copy/tamper detection. */
  mac: string;
}

type Env = Record<string, string | undefined>;

/**
 * Resolve the durable pairing file path. `GALLEY_MCP_PAIRING_FILE` wins (tests/CI);
 * else `${XDG_STATE_HOME:-$HOME/.local/state}/galley/kernel/pairing.json`.
 */
export function resolvePairingFile(env: Env = process.env): string {
  const override = env["GALLEY_MCP_PAIRING_FILE"]?.trim();
  if (override) return override;
  const stateHome = env["XDG_STATE_HOME"]?.trim() || join(env["HOME"]?.trim() || homedir(), ".local", "state");
  return join(stateHome, "galley", "kernel", "pairing.json");
}

/** The sibling local-integrity-key path (next to the pairing file). */
function integrityKeyPath(pairingFile: string): string {
  return join(dirname(pairingFile), "integrity.key");
}

/**
 * Load (or generate-once) the 32-byte LOCAL integrity key at the state root, mode
 * 0600. It NEVER leaves this machine; it only keys the copy-detection MAC. A
 * generate creates the parent dir 0700 first.
 */
function loadOrCreateLocalKey(pairingFile: string): Buffer {
  const keyPath = integrityKeyPath(pairingFile);
  try {
    const raw = readFileSync(keyPath);
    // base64url string → bytes; a legitimate key is 32 bytes.
    const buf = Buffer.from(raw.toString("utf8").trim(), "base64url");
    if (buf.length === 32) return buf;
    // A truncated/garbage key file → regenerate (a fresh key only invalidates an
    // already-untrusted-on-this-host blob; fail-closed either way).
  } catch {
    // not present yet — generate below
  }
  const dir = dirname(keyPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const key = randomBytes(32);
  writeFileSync(keyPath, key.toString("base64url"), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  return key;
}

/**
 * Derive the per-store MAC key = HKDF-SHA-256(localKey, info="pairing-store"). The
 * derivation domain-separates this MAC from any other use of the local key.
 */
function deriveMacKey(localKey: Buffer): Buffer {
  const salt = Buffer.from("galley-pairing-store-v1", "utf8");
  const info = Buffer.from("pairing-store", "utf8");
  return Buffer.from(hkdfSync("sha256", localKey, salt, info, 32));
}

/**
 * The exact bytes the MAC covers: a fixed positional array of strings (no key-order
 * ambiguity, injective). `pairedAt` is a decimal string so it can't collide with a
 * field's text. The `mac` field is NEVER part of its own input.
 */
function pairingMacBytes(p: StoredPairing): Buffer {
  return Buffer.from(
    JSON.stringify(["galley.pairing.v1", p.controlRoom, p.responseKey, String(p.pairedAt)]),
    "utf8",
  );
}

function computeMac(macKey: Buffer, p: StoredPairing): string {
  return createHmac("sha256", macKey).update(pairingMacBytes(p)).digest("base64url");
}

/**
 * Persist the control pairing durably (0600 file under a 0700 dir, MAC'd with the
 * local integrity key). Overwrites any prior pairing. Throws only on an
 * unrecoverable filesystem error (the caller logs it; the in-memory pairing the
 * handshake just obtained is still usable for THIS run).
 */
export async function savePairing(pairing: DurablePairing, env: Env = process.env): Promise<void> {
  // #4: refuse to persist a shape-invalid pairing (bad room / non-32-byte / all-zero
  // key) — never write authority material the load path would have to reject.
  if (!isValidPairingShape(pairing)) {
    throw new Error("pairing-store: refusing to persist a malformed pairing (bad room or key)");
  }
  const file = resolvePairingFile(env);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const localKey = loadOrCreateLocalKey(file);
  const macKey = deriveMacKey(localKey);
  const stored: StoredPairing = {
    controlRoom: pairing.controlRoom,
    responseKey: pairing.responseKey,
    pairedAt: Date.now(),
    mac: "",
  };
  stored.mac = computeMac(macKey, stored);
  writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/**
 * Load + AUTHENTICATE the durable pairing, or null. Returns the control pairing
 * ONLY when the file parses, has the right shape, AND its MAC verifies (timing-safe)
 * under the local-key-derived MAC key. fail-closed: absent / unreadable / malformed
 * / wrong-shape / MAC-mismatch (incl. a file copied from another host) → null. Never
 * throws.
 */
export async function loadPairing(env: Env = process.env): Promise<DurablePairing | null> {
  const file = resolvePairingFile(env);
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null; // absent / unreadable
  }
  // Defense-in-depth (v1 confidentiality boundary is file perms): re-assert 0600
  // on the existing file + 0700 on its dir, so a pairing left world/group-readable
  // (a botched copy, a umask slip) is tightened on the next load. Best-effort.
  try {
    chmodSync(file, 0o600);
    chmodSync(dirname(file), 0o700);
  } catch {
    // best-effort — a chmod failure never blocks the (MAC-verified) load
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // malformed
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const v = parsed as Record<string, unknown>;
  if (
    typeof v["controlRoom"] !== "string" ||
    typeof v["responseKey"] !== "string" ||
    typeof v["pairedAt"] !== "number" ||
    typeof v["mac"] !== "string" ||
    v["mac"] === ""
  ) {
    return null;
  }
  const stored: StoredPairing = {
    controlRoom: v["controlRoom"],
    responseKey: v["responseKey"],
    pairedAt: v["pairedAt"],
    mac: v["mac"],
  };
  let expected: string;
  try {
    const localKey = loadOrCreateLocalKey(file);
    expected = computeMac(deriveMacKey(localKey), stored);
  } catch {
    return null; // cannot authenticate → no pairing
  }
  const offered = Buffer.from(stored.mac, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  if (offered.length !== wanted.length || !timingSafeEqual(offered, wanted)) return null;
  const pairing: DurablePairing = {
    controlRoom: stored.controlRoom,
    responseKey: stored.responseKey,
  };
  // #4: even a MAC-VERIFIED blob must pass the shape gate before it reaches the join
  // path (defense-in-depth: a future bug, or a same-host attacker who also has the
  // integrity key, cannot smuggle a non-capability room / bad key past the kernel).
  if (!isValidPairingShape(pairing)) return null;
  return pairing;
}

/**
 * Delete the durable pairing (e.g. on an explicit re-pair). Best-effort: a missing
 * file is a no-op, never an error. The local integrity key is left in place (it
 * authenticates nothing on its own).
 */
export async function deletePairing(env: Env = process.env): Promise<void> {
  const file = resolvePairingFile(env);
  try {
    rmSync(file, { force: true });
  } catch {
    // best-effort
  }
}
