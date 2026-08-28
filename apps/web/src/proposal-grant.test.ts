import { describe, it, expect } from "vitest";
import {
  macGrant,
  serializeGrant,
  parseGrant,
  grantMatchesReuseScope,
  inheritedGrantMode,
  mintGrantMode,
  grantAuthorizesHeadlessAttach,
  headlessAccessExpired,
  HEADLESS_ACCESS_IDLE_TTL_MS,
  type GrantReuseScope,
  type ProposalGrant,
} from "./proposal-grant.js";

/**
 * Offline unit tests for the MAC'd persisted agent grant (ADR-0023 §4). No DOM /
 * relay — WebCrypto (`crypto.subtle`) is the one runtime dependency and is present
 * in the Node gate. The MAC keys on a fake `responseKey`; the pins prove a grant
 * round-trips, a tamper is rejected, a wrong key is rejected, and absent/malformed
 * blobs fail closed to null.
 */

const KEY = new Uint8Array(32).fill(9);
const OTHER_KEY = new Uint8Array(32).fill(4);

const grant = (over: Partial<ProposalGrant> = {}): ProposalGrant => ({
  controlRoom: "share-controlcontrolcontrol",
  projectId: "proj-1",
  shareRoom: "share-roomroomroomroomroom",
  syncUrl: "ws://127.0.0.1:1234",
  mainFile: "/main.typ",
  grantId: "g0aBcDeF1234_-ZyXwVu",
  mode: "ask",
  grantedAt: 1_700_000_000_000,
  ...over,
});

/**
 * Build a persisted blob in the OLD (`autoAccept:boolean`, no `mode`) shape, MAC'd
 * under the OLD canonical payload exactly as the pre-`mode` code did. Used to pin
 * the fail-closed migration: a VALID old blob upgrades to `mode`, a TAMPERED old
 * blob still yields no grant. The OLD MAC array MUST match the historical
 * `grantArray` byte-for-byte (VERSION + the six coordinates + the boolean as
 * "0"/"1" + the decimal `grantedAt`).
 */
async function oldBlob(
  over: { autoAccept?: boolean; omitAutoAccept?: boolean } = {},
  key: Uint8Array = KEY,
): Promise<string> {
  const autoAccept = over.autoAccept ?? false;
  const g = grant();
  // The OLD canonical MAC slot encoded `autoAccept ? "1" : "0"`; the NEW encoding
  // is `mode === "auto" ? "1" : "0"` (byte-identical). So MAC the equivalent NEW
  // grant — same bytes the old code signed — then write the blob in the OLD shape
  // (drop `mode`, add `autoAccept`) so the migration path is what's exercised.
  const mac = await macGrant(key, { ...g, mode: autoAccept ? "auto" : "ask" });
  const fields: Record<string, unknown> = {
    controlRoom: g.controlRoom,
    projectId: g.projectId,
    shareRoom: g.shareRoom,
    syncUrl: g.syncUrl,
    mainFile: g.mainFile,
    grantId: g.grantId,
    grantedAt: g.grantedAt,
    mac,
  };
  if (!over.omitAutoAccept) fields["autoAccept"] = autoAccept;
  return JSON.stringify(fields);
}

describe("proposal-grant — MAC round-trip", () => {
  it("serialize → parse with a matching MAC returns the grant", async () => {
    const g = grant();
    const mac = await macGrant(KEY, g);
    const raw = serializeGrant(g, mac);
    expect(await parseGrant(raw, KEY)).toEqual(g);
  });

  it("a new grant defaults mode:\"ask\"", () => {
    expect(grant().mode).toBe("ask");
  });

  it("preserves mode:\"auto\" through a round-trip", async () => {
    const g = grant({ mode: "auto" });
    const mac = await macGrant(KEY, g);
    const parsed = await parseGrant(serializeGrant(g, mac), KEY);
    expect(parsed?.mode).toBe("auto");
  });

  it("the MAC does not cover itself (serialized blob carries a separate mac field)", async () => {
    const g = grant();
    const mac = await macGrant(KEY, g);
    const blob = JSON.parse(serializeGrant(g, mac)) as Record<string, unknown>;
    expect(blob["mac"]).toBe(mac);
    // The blob without `mac` re-MACs to the same value (mac is not in the input).
    const { mac: _drop, ...fields } = blob;
    expect(await macGrant(KEY, fields as unknown as ProposalGrant)).toBe(mac);
  });
});

describe("proposal-grant — fail closed", () => {
  it("a tampered field (swapped shareRoom) → parse returns null", async () => {
    const g = grant();
    const mac = await macGrant(KEY, g);
    // Persist the original MAC but a tampered shareRoom: the recomputed MAC differs.
    const raw = serializeGrant({ ...g, shareRoom: "share-EVILEVILEVILEVILEVIL" }, mac);
    expect(await parseGrant(raw, KEY)).toBeNull();
  });

  it("a flipped mode → parse returns null", async () => {
    const g = grant({ mode: "ask" });
    const mac = await macGrant(KEY, g);
    const raw = serializeGrant({ ...g, mode: "auto" }, mac);
    expect(await parseGrant(raw, KEY)).toBeNull();
  });

  it("parse with the WRONG responseKey → null", async () => {
    const g = grant();
    const mac = await macGrant(KEY, g);
    expect(await parseGrant(serializeGrant(g, mac), OTHER_KEY)).toBeNull();
  });

  it("absent (null raw) → null", async () => {
    expect(await parseGrant(null, KEY)).toBeNull();
  });

  it("malformed JSON → null", async () => {
    expect(await parseGrant("{not json", KEY)).toBeNull();
  });

  it("a blob with no mac field → null", async () => {
    const raw = JSON.stringify(grant());
    expect(await parseGrant(raw, KEY)).toBeNull();
  });

  it("a wrong-shape blob (missing grantId) → null", async () => {
    const g = grant();
    const mac = await macGrant(KEY, g);
    const blob = JSON.parse(serializeGrant(g, mac)) as Record<string, unknown>;
    delete blob["grantId"];
    expect(await parseGrant(JSON.stringify(blob), KEY)).toBeNull();
  });
});

describe("proposal-grant — grantMatchesReuseScope (ADR-0024 §3)", () => {
  const liveOf = (g: ProposalGrant): GrantReuseScope => ({
    controlRoom: g.controlRoom,
    syncUrl: g.syncUrl,
    projectId: g.projectId,
    shareRoom: g.shareRoom,
    mainFile: g.mainFile,
  });

  it("matches when every live coordinate equals the grant's", () => {
    const g = grant();
    expect(grantMatchesReuseScope(g, liveOf(g))).toBe(true);
  });

  it("ignores mode / grantedAt / grantId (not in the live scope)", () => {
    const g = grant({ mode: "auto", grantedAt: 42, grantId: "gDifferent1234_-ZyXwVu" });
    // The live scope only carries the 5 re-derivable coordinates; the grant's own
    // arming switch, timestamp and id never gate reuse.
    expect(grantMatchesReuseScope(g, liveOf(g))).toBe(true);
  });

  it.each([
    ["controlRoom", { controlRoom: "share-otherotherotherother00" }],
    ["syncUrl", { syncUrl: "ws://127.0.0.1:9999" }],
    ["projectId", { projectId: "proj-2" }],
    ["shareRoom", { shareRoom: "share-otherroomotherroom0000" }],
    ["mainFile", { mainFile: "/other.typ" }],
  ])("a drift in %s → no reuse (fall through to consent)", (_field, over) => {
    const g = grant();
    const live = { ...liveOf(g), ...over } as GrantReuseScope;
    expect(grantMatchesReuseScope(g, live)).toBe(false);
  });
});

describe("proposal-grant — inheritedGrantMode (H1 broken authority scoping)", () => {
  const liveOf = (g: ProposalGrant): GrantReuseScope => ({
    controlRoom: g.controlRoom,
    syncUrl: g.syncUrl,
    projectId: g.projectId,
    shareRoom: g.shareRoom,
    mainFile: g.mainFile,
  });

  it("a fresh grant with NO prior grant defaults to ask", () => {
    expect(inheritedGrantMode(null, liveOf(grant()))).toBe("ask");
  });

  it("a new grant in project B does NOT inherit project A's Auto (defaults ask)", () => {
    // Prior grant: project A, Auto. New grant being recorded: project B.
    const priorA = grant({ projectId: "proj-A", mode: "auto" });
    const liveB = liveOf(grant({ projectId: "proj-B" }));
    expect(inheritedGrantMode(priorA, liveB)).toBe("ask");
  });

  it("inherits Auto ONLY when the prior grant is the EXACT same full scope", () => {
    const prior = grant({ mode: "auto" });
    // Same full reuse scope → a continuation of the same grant → inherit Auto.
    expect(inheritedGrantMode(prior, liveOf(prior))).toBe("auto");
  });

  it.each([
    ["controlRoom", { controlRoom: "share-otherotherotherother00" }],
    ["syncUrl", { syncUrl: "ws://127.0.0.1:9999" }],
    ["projectId", { projectId: "proj-2" }],
    ["shareRoom", { shareRoom: "share-otherroomotherroom0000" }],
    ["mainFile", { mainFile: "/other.typ" }],
  ])("a drift in %s drops the inherited Auto back to ask", (_field, over) => {
    const prior = grant({ mode: "auto" });
    const live = { ...liveOf(prior), ...over } as GrantReuseScope;
    expect(inheritedGrantMode(prior, live)).toBe("ask");
  });
});

describe("proposal-grant — persistentAccess (F13 standing headless grant)", () => {
  const liveOf = (g: ProposalGrant): GrantReuseScope => ({
    controlRoom: g.controlRoom,
    syncUrl: g.syncUrl,
    projectId: g.projectId,
    shareRoom: g.shareRoom,
    mainFile: g.mainFile,
  });

  it("round-trips a persistentAccess:true grant through serialize → parse", async () => {
    const g = grant({ persistentAccess: true });
    const mac = await macGrant(KEY, g);
    expect(await parseGrant(serializeGrant(g, mac), KEY)).toEqual(g);
  });

  it("an absent/false flag MACs byte-identically (legacy parity) but true changes the MAC", async () => {
    const macAbsent = await macGrant(KEY, grant());
    const macFalse = await macGrant(KEY, grant({ persistentAccess: false }));
    const macTrue = await macGrant(KEY, grant({ persistentAccess: true }));
    // Absent and explicit-false both omit the slot → identical bytes → legacy blobs
    // (signed without the field) still re-bind unchanged.
    expect(macFalse).toBe(macAbsent);
    // The standing capability is MAC-distinct, so it cannot be confused with a
    // non-standing grant.
    expect(macTrue).not.toBe(macAbsent);
  });

  it("a tampered blob that FLIPS persistentAccess on → parse returns null (fail closed)", async () => {
    // Sign a NON-standing grant, then hand-edit the JSON to claim persistentAccess.
    const g = grant();
    const mac = await macGrant(KEY, g);
    const blob = JSON.parse(serializeGrant(g, mac)) as Record<string, unknown>;
    blob["persistentAccess"] = true;
    expect(await parseGrant(JSON.stringify(blob), KEY)).toBeNull();
  });

  it("a tampered blob that FLIPS persistentAccess off → parse returns null", async () => {
    const g = grant({ persistentAccess: true });
    const mac = await macGrant(KEY, g);
    const raw = serializeGrant({ ...g, persistentAccess: false }, mac);
    expect(await parseGrant(raw, KEY)).toBeNull();
  });

  it("a non-boolean persistentAccess is malformed → parse returns null", async () => {
    const g = grant();
    const mac = await macGrant(KEY, g);
    const blob = JSON.parse(serializeGrant(g, mac)) as Record<string, unknown>;
    blob["persistentAccess"] = "yes";
    expect(await parseGrant(JSON.stringify(blob), KEY)).toBeNull();
  });

  it("grantAuthorizesHeadlessAttach: true only with the flag + exact scope + not idle", () => {
    const now = 2_000_000_000_000;
    const fresh = now - 1000;
    const g = grant({ persistentAccess: true });
    expect(grantAuthorizesHeadlessAttach(g, liveOf(g), fresh, now)).toBe(true);
    // No standing flag → never headless.
    expect(grantAuthorizesHeadlessAttach(grant(), liveOf(g), fresh, now)).toBe(false);
    // Scope drift (different project) → never headless (no carry-over).
    const other = { ...liveOf(g), projectId: "proj-2" };
    expect(grantAuthorizesHeadlessAttach(g, other, fresh, now)).toBe(false);
    // Idle past the TTL → degraded to manual.
    const stale = now - HEADLESS_ACCESS_IDLE_TTL_MS - 1;
    expect(grantAuthorizesHeadlessAttach(g, liveOf(g), stale, now)).toBe(false);
  });

  it("headlessAccessExpired honours the 7-day idle window and fails closed on a bad stamp", () => {
    const now = 2_000_000_000_000;
    expect(headlessAccessExpired(now - 1000, now)).toBe(false);
    expect(headlessAccessExpired(now - HEADLESS_ACCESS_IDLE_TTL_MS + 1, now)).toBe(false);
    expect(headlessAccessExpired(now - HEADLESS_ACCESS_IDLE_TTL_MS, now)).toBe(true);
    expect(headlessAccessExpired(Number.NaN, now)).toBe(true);
    expect(HEADLESS_ACCESS_IDLE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("proposal-grant — mintGrantMode (F12 arm-before-pair)", () => {
  it("seeds Auto when the human armed Auto for THIS project (inherited ask, project auto)", () => {
    // The arm-before-pair case: no same-scope prior grant (inherited "ask"), but
    // the project's in-app setting is Auto → the freshly minted grant is Auto.
    expect(mintGrantMode("ask", "auto")).toBe("auto");
  });

  it("stays Ask (fail-closed) when neither the prior grant nor the project is Auto", () => {
    expect(mintGrantMode("ask", "ask")).toBe("ask");
  });

  it("keeps inherited Auto even when the project setting is Ask (continuation wins)", () => {
    expect(mintGrantMode("auto", "ask")).toBe("auto");
  });

  it("is Auto when both the inherited mode and the project setting are Auto", () => {
    expect(mintGrantMode("auto", "auto")).toBe("auto");
  });

  it("never reads a DIFFERENT project's Auto — the caller passes this project's setting only", () => {
    // mintGrantMode is pure: cross-project isolation lives at the call site, which
    // reads getProjectAcceptanceMode(projectId) for the SINGLE just-consented
    // project. A stale Auto on project A surfaces here only if the caller passed
    // it — and the caller never does for project B. Pin the contract: the second
    // arg is the project mode, full stop; project A's Auto cannot leak in.
    const projectBSetting = "ask"; // project B was never armed
    expect(mintGrantMode("ask", projectBSetting)).toBe("ask");
  });
});

describe("proposal-grant — legacy autoAccept migration (ADR-0025 §7, fail-closed)", () => {
  it("a VALID old blob {autoAccept:true} (MAC over OLD shape) parses → mode:\"auto\"", async () => {
    const parsed = await parseGrant(await oldBlob({ autoAccept: true }), KEY);
    expect(parsed).not.toBeNull();
    expect(parsed?.mode).toBe("auto");
  });

  it("a VALID old blob {autoAccept:false} → mode:\"ask\"", async () => {
    const parsed = await parseGrant(await oldBlob({ autoAccept: false }), KEY);
    expect(parsed?.mode).toBe("ask");
  });

  it("a VALID old blob with NO autoAccept field → mode:\"ask\"", async () => {
    // The MAC was computed with autoAccept treated as false (the historical default).
    const parsed = await parseGrant(await oldBlob({ autoAccept: false, omitAutoAccept: true }), KEY);
    expect(parsed?.mode).toBe("ask");
  });

  it("the migrated grant re-MACs cleanly under the NEW shape (re-persistable)", async () => {
    const parsed = await parseGrant(await oldBlob({ autoAccept: true }), KEY);
    expect(parsed).not.toBeNull();
    const mac = await macGrant(KEY, parsed!);
    // The upgraded grant round-trips through the NEW parse path with its own MAC.
    expect(await parseGrant(serializeGrant(parsed!, mac), KEY)).toEqual(parsed);
  });

  it("a TAMPERED old blob (valid old shape, WRONG mac) → null (never silently upgraded)", async () => {
    const raw = await oldBlob({ autoAccept: true });
    const blob = JSON.parse(raw) as { mac: string };
    blob.mac = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(await parseGrant(JSON.stringify(blob), KEY)).toBeNull();
  });

  it("a VALID old blob under the WRONG key → null (fail closed)", async () => {
    expect(await parseGrant(await oldBlob({ autoAccept: true }, KEY), OTHER_KEY)).toBeNull();
  });
});
