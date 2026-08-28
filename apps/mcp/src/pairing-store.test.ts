import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPairing,
  savePairing,
  deletePairing,
  resolvePairingFile,
  type DurablePairing,
} from "./pairing-store.js";

/**
 * The kernel secret-at-rest tests (B2, ADR-0026). The durable pairing
 * (controlRoom + responseKey) is stored 0600 under a 0700 dir, integrity-MAC'd
 * with a separate LOCAL integrity key (also 0600) so a pairing.json copied to
 * another machine FAILS the MAC. fail-closed: a bad/absent/tampered file → null
 * (the kernel falls back to args). These are gating tests — the security review
 * scrutinizes the perms + the copy-detection MAC hardest.
 */

let dir: string;
const file = (): string => join(dir, "pairing.json");
const env = (): Record<string, string> => ({ GALLEY_MCP_PAIRING_FILE: file() });

const PAIRING: DurablePairing = {
  controlRoom: "share-0123456789abcdef0123456789abcdef",
  responseKey: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE", // 32 x "A"
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "galley-pairing-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("resolvePairingFile — path resolution", () => {
  it("honors the GALLEY_MCP_PAIRING_FILE override", () => {
    expect(resolvePairingFile({ GALLEY_MCP_PAIRING_FILE: "/tmp/x/pairing.json" })).toBe(
      "/tmp/x/pairing.json",
    );
  });

  it("uses XDG_STATE_HOME when set", () => {
    const p = resolvePairingFile({ XDG_STATE_HOME: "/xdg/state" });
    expect(p).toBe("/xdg/state/galley/kernel/pairing.json");
  });

  it("falls back to $HOME/.local/state when XDG_STATE_HOME is absent", () => {
    const p = resolvePairingFile({ HOME: "/home/me" });
    expect(p).toBe("/home/me/.local/state/galley/kernel/pairing.json");
  });
});

describe("savePairing / loadPairing — round-trip", () => {
  it("saves then loads the same pairing", async () => {
    await savePairing(PAIRING, env());
    const loaded = await loadPairing(env());
    expect(loaded).toEqual(PAIRING);
  });

  it("writes the pairing file 0600 and the dir 0700", async () => {
    await savePairing(PAIRING, env());
    const fileMode = statSync(file()).mode & 0o777;
    const dirMode = statSync(dir).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(dirMode).toBe(0o700);
  });

  it("writes a separate local integrity key file 0600", async () => {
    await savePairing(PAIRING, env());
    const keyPath = join(dir, "integrity.key");
    expect(existsSync(keyPath)).toBe(true);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it("the persisted blob carries controlRoom + responseKey + pairedAt + mac", async () => {
    await savePairing(PAIRING, env());
    const blob = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
    expect(blob["controlRoom"]).toBe(PAIRING.controlRoom);
    expect(blob["responseKey"]).toBe(PAIRING.responseKey);
    expect(typeof blob["pairedAt"]).toBe("number");
    expect(typeof blob["mac"]).toBe("string");
  });
});

describe("MAC integrity — fail closed", () => {
  it("a tampered controlRoom fails the MAC → load returns null", async () => {
    await savePairing(PAIRING, env());
    const blob = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
    blob["controlRoom"] = "share-evilevilevilevilevilevilevil";
    writeFileSync(file(), JSON.stringify(blob));
    expect(await loadPairing(env())).toBeNull();
  });

  it("a tampered responseKey fails the MAC → load returns null", async () => {
    await savePairing(PAIRING, env());
    const blob = JSON.parse(readFileSync(file(), "utf8")) as Record<string, unknown>;
    blob["responseKey"] = "QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI";
    writeFileSync(file(), JSON.stringify(blob));
    expect(await loadPairing(env())).toBeNull();
  });

  it("copying ONLY pairing.json to another state root fails the MAC (different local key)", async () => {
    await savePairing(PAIRING, env());
    const validBlob = readFileSync(file(), "utf8");
    // A second state root with its OWN integrity key.
    const dir2 = mkdtempSync(join(tmpdir(), "galley-pairing2-"));
    const file2 = join(dir2, "pairing.json");
    const env2 = { GALLEY_MCP_PAIRING_FILE: file2 };
    await savePairing(PAIRING, env2); // generates dir2's own local key
    // Now overwrite dir2's pairing.json with dir1's blob (the "stolen file").
    writeFileSync(file2, validBlob);
    expect(await loadPairing(env2)).toBeNull();
    rmSync(dir2, { recursive: true, force: true });
  });

  it("a missing pairing file → null (not an error)", async () => {
    expect(await loadPairing(env())).toBeNull();
  });

  it("a malformed (non-JSON) pairing file → null, never throws", async () => {
    writeFileSync(file(), "}{ not json");
    expect(await loadPairing(env())).toBeNull();
  });

  it("a wrong-shape blob (missing fields) → null", async () => {
    writeFileSync(file(), JSON.stringify({ controlRoom: "share-x" }));
    expect(await loadPairing(env())).toBeNull();
  });
});

describe("shape validation (#4) — fail-closed on save AND load", () => {
  it("savePairing REFUSES a non-capability controlRoom", async () => {
    await expect(savePairing({ ...PAIRING, controlRoom: "not-a-cap" }, env())).rejects.toThrow(
      /malformed pairing/,
    );
  });

  it("savePairing REFUSES a responseKey that is not 32 bytes", async () => {
    await expect(savePairing({ ...PAIRING, responseKey: "QUFB" }, env())).rejects.toThrow(
      /malformed pairing/,
    );
  });

  it("savePairing REFUSES an all-zero responseKey", async () => {
    const allZero = Buffer.alloc(32).toString("base64url");
    await expect(savePairing({ ...PAIRING, responseKey: allZero }, env())).rejects.toThrow(
      /malformed pairing/,
    );
  });

  it("loadPairing rejects a MAC-valid-but-bad-shape blob (defense-in-depth)", async () => {
    // Save a VALID pairing first (mints the local integrity key), then re-MAC a
    // bad-shape pairing with the SAME local key so its MAC verifies — load must
    // STILL reject it on the shape gate.
    await savePairing(PAIRING, env());
    const keyRaw = readFileSync(join(dir, "integrity.key"), "utf8").trim();
    const localKey = Buffer.from(keyRaw, "base64url");
    const { hkdfSync, createHmac } = await import("node:crypto");
    const macKey = Buffer.from(
      hkdfSync(
        "sha256",
        localKey,
        Buffer.from("galley-pairing-store-v1"),
        Buffer.from("pairing-store"),
        32,
      ),
    );
    const bad = {
      controlRoom: "not-a-capability-room",
      responseKey: PAIRING.responseKey,
      pairedAt: Date.now(),
    };
    const mac = createHmac("sha256", macKey)
      .update(
        Buffer.from(
          JSON.stringify(["galley.pairing.v1", bad.controlRoom, bad.responseKey, String(bad.pairedAt)]),
        ),
      )
      .digest("base64url");
    writeFileSync(file(), JSON.stringify({ ...bad, mac }));
    expect(await loadPairing(env())).toBeNull();
  });
});

describe("deletePairing", () => {
  it("removes the pairing file so a later load is null", async () => {
    await savePairing(PAIRING, env());
    expect(await loadPairing(env())).not.toBeNull();
    await deletePairing(env());
    expect(await loadPairing(env())).toBeNull();
  });

  it("is a no-op when nothing is stored (never throws)", async () => {
    await expect(deletePairing(env())).resolves.toBeUndefined();
  });
});
