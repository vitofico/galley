import { describe, it, expect } from "vitest";
import {
  deriveProposalKey, signProposal, verifyProposal, proposalSigningBytes,
  proposalSignedDigest, type ProposalScope, type SignableProposal,
} from "./proposal-provenance.js";

const KEY = new Uint8Array(32).fill(7);
const scope = (over: Partial<ProposalScope> = {}): ProposalScope => ({
  grantId: "g1", controlRoom: "share-controlcontrolcontrol", syncUrl: "ws://127.0.0.1:9 ",
  projectId: "proj1", shareRoom: "share-roomroomroomroomroom", mailbox: "mcpFileProposals", ...over,
}).valueOf() as ProposalScope;
const prop = (over: Partial<SignableProposal> = {}): SignableProposal => ({
  id: "abc", createdAt: 100, seq: 0, request: "do x",
  ops: [{ kind: "edit", path: "/a.typ", newPath: null, baseText: "x", proposedText: "y", blocks: [{ search: "x", replace: "y" }] }],
  ...over,
});

it("sign/verify round-trips", async () => {
  const k = await deriveProposalKey(KEY, scope());
  const sig = await signProposal(k, scope(), prop());
  expect(await verifyProposal(k, scope(), prop(), sig)).toBe(true);
});

it("syncUrl trailing slashes are normalized — kernel (slash-stripped) and browser agree", async () => {
  // The kernel strips trailing slashes to build its join URL; the browser may
  // persist the un-stripped form. scopeArray normalizes both, so a sig made with
  // a slash-suffixed syncUrl verifies against the stripped one (same derived key
  // AND same signed bytes).
  const withSlash = scope({ syncUrl: "ws://relay.example:1234/" });
  const noSlash = scope({ syncUrl: "ws://relay.example:1234" });
  const k = await deriveProposalKey(KEY, withSlash);
  const sig = await signProposal(k, withSlash, prop());
  const k2 = await deriveProposalKey(KEY, noSlash);
  expect(await verifyProposal(k2, noSlash, prop(), sig)).toBe(true);
  expect(Buffer.from(proposalSigningBytes(withSlash, prop())).equals(Buffer.from(proposalSigningBytes(noSlash, prop())))).toBe(true);
});

it("tamper in any signed field fails verify", async () => {
  const k = await deriveProposalKey(KEY, scope());
  const sig = await signProposal(k, scope(), prop());
  expect(await verifyProposal(k, scope(), prop({ request: "do z" }), sig)).toBe(false);
  expect(await verifyProposal(k, scope(), prop({ ops: [{ kind: "edit", path: "/a.typ", newPath: null, baseText: "x", proposedText: "Z", blocks: [{ search: "x", replace: "Z" }] }] }), sig)).toBe(false);
});

it("scope domain-separates: a sig from room A never verifies in room B", async () => {
  const kA = await deriveProposalKey(KEY, scope({ shareRoom: "share-AAAAAAAAAAAAAAAA" }));
  const sigA = await signProposal(kA, scope({ shareRoom: "share-AAAAAAAAAAAAAAAA" }), prop());
  const kB = await deriveProposalKey(KEY, scope({ shareRoom: "share-BBBBBBBBBBBBBBBB" }));
  expect(await verifyProposal(kB, scope({ shareRoom: "share-BBBBBBBBBBBBBBBB" }), prop(), sigA)).toBe(false);
});

it("different grantId derives a different key (stale-signer)", async () => {
  const k1 = await deriveProposalKey(KEY, scope({ grantId: "g1" }));
  const sig1 = await signProposal(k1, scope({ grantId: "g1" }), prop());
  const k2 = await deriveProposalKey(KEY, scope({ grantId: "g2" }));
  expect(await verifyProposal(k2, scope({ grantId: "g2" }), prop(), sig1)).toBe(false);
});

it("downgrade: null key, missing/garbage sig all verify false (never throw)", async () => {
  const k = await deriveProposalKey(KEY, scope());
  expect(await verifyProposal(null, scope(), prop(), "x")).toBe(false);
  expect(await verifyProposal(k, scope(), prop(), undefined)).toBe(false);
  expect(await verifyProposal(k, scope(), prop(), "")).toBe(false);
  expect(await verifyProposal(k, scope(), prop(), 123 as unknown)).toBe(false);
});

it("canonical bytes are injective across a delimiter-injection attempt", () => {
  const a = proposalSigningBytes(scope(), prop({ request: "a", ops: [{ kind: "edit", path: "/b", newPath: null, baseText: "", proposedText: "", blocks: [] }] }));
  const b = proposalSigningBytes(scope(), prop({ request: "a /b", ops: [{ kind: "edit", path: "", newPath: null, baseText: "", proposedText: "", blocks: [] }] }));
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
});

it("digest is stable and needs no key", async () => {
  const d1 = await proposalSignedDigest(scope(), prop());
  const d2 = await proposalSignedDigest(scope(), prop());
  expect(d1).toBe(d2);
  expect(d1).toMatch(/^[A-Za-z0-9_-]+$/);
});

// --- A2: binary pointer is covered by the signature -------------------------
const binProp = (over: Partial<SignableProposal> = {}): SignableProposal => ({
  id: "bin1", createdAt: 200, seq: 1, request: "add logo",
  ops: [{
    kind: "create-binary", path: "/logo.png", newPath: null, baseText: "", proposedText: "", blocks: [],
    binaryAsset: { hash: "a".repeat(64), size: 1234, mime: "image/png" },
  }],
  ...over,
});

it("a create-binary proposal signs and verifies", async () => {
  const k = await deriveProposalKey(KEY, scope());
  const sig = await signProposal(k, scope(), binProp());
  expect(await verifyProposal(k, scope(), binProp(), sig)).toBe(true);
});

it("mutating hash / size / mime on a signed create-binary op fails verify (the swap guard)", async () => {
  const k = await deriveProposalKey(KEY, scope());
  const sig = await signProposal(k, scope(), binProp());
  const swapHash = binProp({ ops: [{ kind: "create-binary", path: "/logo.png", newPath: null, baseText: "", proposedText: "", blocks: [], binaryAsset: { hash: "b".repeat(64), size: 1234, mime: "image/png" } }] });
  const swapSize = binProp({ ops: [{ kind: "create-binary", path: "/logo.png", newPath: null, baseText: "", proposedText: "", blocks: [], binaryAsset: { hash: "a".repeat(64), size: 9999, mime: "image/png" } }] });
  const swapMime = binProp({ ops: [{ kind: "create-binary", path: "/logo.png", newPath: null, baseText: "", proposedText: "", blocks: [], binaryAsset: { hash: "a".repeat(64), size: 1234, mime: "image/gif" } }] });
  expect(await verifyProposal(k, scope(), swapHash, sig)).toBe(false);
  expect(await verifyProposal(k, scope(), swapSize, sig)).toBe(false);
  expect(await verifyProposal(k, scope(), swapMime, sig)).toBe(false);
});

it("an op with absent binaryAsset signs identically to one with binaryAsset:null (canonical slot)", () => {
  const withAbsent = prop();
  const withNull = prop({ ops: [{ kind: "edit", path: "/a.typ", newPath: null, baseText: "x", proposedText: "y", blocks: [{ search: "x", replace: "y" }], binaryAsset: null }] });
  expect(Buffer.from(proposalSigningBytes(scope(), withAbsent)).equals(Buffer.from(proposalSigningBytes(scope(), withNull)))).toBe(true);
});

it("the v2 version tag is in the signed bytes (old v1 sigs are unambiguous)", () => {
  const bytes = new TextDecoder().decode(proposalSigningBytes(scope(), prop()));
  expect(bytes).toContain("galley.mcp.proposal.v2");
});

it("dec() rejects a non-safe-integer in the signed set (injective signing primitive — D1)", () => {
  // A fractional createdAt would otherwise truncate (5.9 → "5"), so two distinct
  // numbers could sign identically. proposalSigningBytes must THROW instead.
  expect(() => proposalSigningBytes(scope(), prop({ createdAt: 5.9 }))).toThrow();
  expect(() => proposalSigningBytes(scope(), prop({ seq: 1.5 }))).toThrow();
  // A fractional binaryAsset.size is likewise rejected (it rides through dec()).
  expect(() =>
    proposalSigningBytes(
      scope(),
      binProp({ ops: [{ kind: "create-binary", path: "/a.png", newPath: null, baseText: "", proposedText: "", blocks: [], binaryAsset: { hash: "a".repeat(64), size: 1.5, mime: "image/png" } }] }),
    ),
  ).toThrow();
  // A safe integer still signs fine.
  expect(() => proposalSigningBytes(scope(), prop({ createdAt: 5 }))).not.toThrow();
});
