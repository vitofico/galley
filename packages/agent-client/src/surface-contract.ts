/**
 * Compile-time contract: the shipped, self-contained public surface
 * (`../surface/agent-client.d.ts`) MUST stay in lockstep with the real package
 * surface (`./index.ts`).
 *
 * This file is TYPE-CHECKED, never run, never bundled, never shipped: `esbuild`
 * only pulls in `index.ts`, vitest ignores non-`.test.ts` files, and it emits no
 * runtime code (every construct below is type-only). `pnpm typecheck` and the
 * bundle script's gate both compile it, so any drift in an export's SHAPE — or in
 * the set of VALUE exports — fails loudly right here.
 *
 * The one thing a type-level check cannot see is a newly-ADDED type-only export
 * on `index.ts` (TypeScript can't enumerate a module's type exports); that gap is
 * closed by the exhaustive name+kind check in `scripts/check-surface.mjs`.
 */

// `Real`/`Pinned` = the module object types → their keys are the VALUE exports.
type Real = typeof import("./index.js");
type Pinned = typeof import("../surface/agent-client.js");

// Namespaces usable in TYPE position → for the type-only exports below.
import type * as RealT from "./index.js";
import type * as PinnedT from "../surface/agent-client.js";

/** Invariant type-equality: false unless A and B are mutually identical (optionality included). */
type IsExact<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;
type Expect<T extends true> = T;

// --- value exports: name-set parity (catches add / remove / rename) -----------
type _valueNames = Expect<IsExact<keyof Real, keyof Pinned>>;

// --- value exports: shape parity ----------------------------------------------
type _connect = Expect<
  IsExact<Real["connectDraftPublisher"], Pinned["connectDraftPublisher"]>
>;
type _runId = Expect<
  IsExact<Real["DRAFT_PUBLISHER_RUN_ID"], Pinned["DRAFT_PUBLISHER_RUN_ID"]>
>;
type _proposalLimits = Expect<
  IsExact<Real["PROPOSAL_LIMITS"], Pinned["PROPOSAL_LIMITS"]>
>;
type _fileProposalLimits = Expect<
  IsExact<Real["FILE_PROPOSAL_LIMITS"], Pinned["FILE_PROPOSAL_LIMITS"]>
>;
type _runIdMaxLen = Expect<
  IsExact<Real["RUN_ID_MAX_LEN"], Pinned["RUN_ID_MAX_LEN"]>
>;

// --- type exports: shape parity (a removed export fails to resolve here) -------
type _draftPublisher = Expect<
  IsExact<RealT.DraftPublisher, PinnedT.DraftPublisher>
>;
type _draftPublisherConfig = Expect<
  IsExact<RealT.DraftPublisherConfig, PinnedT.DraftPublisherConfig>
>;
type _draftPublisherOptions = Expect<
  IsExact<RealT.DraftPublisherOptions, PinnedT.DraftPublisherOptions>
>;
type _proposalInput = Expect<
  IsExact<RealT.ProposalInput, PinnedT.ProposalInput>
>;
type _proposalRecord = Expect<
  IsExact<RealT.ProposalRecord, PinnedT.ProposalRecord>
>;
type _proposalStatus = Expect<
  IsExact<RealT.ProposalStatus, PinnedT.ProposalStatus>
>;
type _fileProposalInput = Expect<
  IsExact<RealT.FileProposalInput, PinnedT.FileProposalInput>
>;
type _fileProposalRecord = Expect<
  IsExact<RealT.FileProposalRecord, PinnedT.FileProposalRecord>
>;
type _fileProposalOp = Expect<
  IsExact<RealT.FileProposalOp, PinnedT.FileProposalOp>
>;

// Reference every alias so `noUnusedLocals`-style tooling can't strip the checks.
export type __SurfaceContract = [
  _valueNames,
  _connect,
  _runId,
  _proposalLimits,
  _fileProposalLimits,
  _runIdMaxLen,
  _draftPublisher,
  _draftPublisherConfig,
  _draftPublisherOptions,
  _proposalInput,
  _proposalRecord,
  _proposalStatus,
  _fileProposalInput,
  _fileProposalRecord,
  _fileProposalOp,
];
