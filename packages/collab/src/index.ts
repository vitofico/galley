/**
 * @galley/collab — the framework-agnostic CRDT collaboration core.
 *
 * Phase 1 (ADR-0006): the agent as a peer, offline and testable. A
 * `CollabDocument` holds the Typst source in a Yjs `Y.Text`; `applyAgentEdits`
 * applies the agent's existing search/replace blocks as an author-tagged CRDT
 * transaction so human and AI edits merge conflict-free.
 *
 * Phase 2 sync core (ADR-0007): `CollabConnection` binds a document + a Yjs
 * `Awareness` to a `Transport`, speaking the standard `y-protocols` sync +
 * awareness wire format. `InMemoryNetwork` provides an offline multi-peer hub
 * for tests. Still no React, no DOM, no real network — the real y-websocket
 * server and the CodeMirror editor binding are later Phase 2 slices.
 */
export { CollabDocument, authorOrigin } from "./collab-document.js";
export { seedIfPristine } from "./seed.js";
export {
  registerAuthor,
  renameAuthor,
  authorForClientID,
  distinctAuthors,
  attributedRanges,
  textAttributedRanges,
  attributionAt,
  observeAttribution,
  observeTextAttribution,
  observeAuthors,
} from "./attribution.js";
export type { AttributedRange, AuthorHost } from "./attribution.js";
export type { DocHost } from "./collab-connection.js";
export { applyAgentEdits } from "./apply-agent-edits.js";
export type { CollabApplyResult } from "./apply-agent-edits.js";
export { CollabProject } from "./collab-project.js";
export type {
  FileIdGenerator,
  ProjectFileSnapshot,
  BinaryFileSnapshot,
  ProjectSnapshot,
  SeedFile,
} from "./collab-project.js";
export {
  materializeProject,
  materializeProjectBinaries,
  projectInstructionsFromTree,
  PROJECT_MANIFEST_PATH,
  PROJECT_INSTRUCTIONS_PATH,
} from "./materialize.js";
// Roadmap #14 (Unification) seed: single-file draft → one-file ProjectSnapshot.
export {
  draftToProjectSnapshot,
  DEFAULT_DRAFT_PATH,
  DEFAULT_DRAFT_FILE_ID,
} from "./unify.js";
export type { DraftImportOptions } from "./unify.js";
export {
  snapshotDoc,
  restoreDoc,
  compactUpdates,
  shouldCompact,
  compactLogIfNeeded,
  COMPACTION_MAX_LOG_ENTRIES,
  COMPACTION_MAX_LOG_BYTES,
} from "./crdt-snapshot.js";
export type {
  MaterializedFile,
  MaterializedBinaryFile,
  MaterializeBinariesOutcome,
  ProjectManifest,
  MaterializeResult,
  MaterializeOutcome,
  MaterializeOptions,
} from "./materialize.js";
export { CollabConnection, AGENT_WORKER_PRESENCE_FIELD } from "./collab-connection.js";
export type {
  Presence,
  ConnectionStatus,
  StorageFullInfo,
  StorageFullReason,
} from "./collab-connection.js";
export { InMemoryNetwork } from "./transport.js";
export type { Transport, TransportStatus } from "./transport.js";
export { WebSocketTransport } from "./websocket-transport.js";
export type {
  WebSocketLike,
  WebSocketFactory,
  SchedulerLike,
  ReconnectOptions,
} from "./websocket-transport.js";
// Project export bundle (roadmap #17.5): a ProjectSnapshot -> downloadable .typ tar.
// `writeUstar` is the reusable deterministic archive core, shared with the
// git-repo export in @galley/persistence (same roadmap item, export breadth).
export { bundleProject, writeUstar } from "./project-bundle.js";
export type { ProjectBundle, BundleOutcome, UstarEntry } from "./project-bundle.js";
// MCP pending-proposal mailbox (roadmap #16.1, ADR-0020): the shared CRDT
// contract between the local MCP kernel and the browser's mandatory Accept gate.
export {
  publishProposal,
  getProposals,
  getPendingProposals,
  getProposal,
  observeProposals,
  resolveProposal,
  proposalSizeViolation,
  PROPOSAL_LIMITS,
  publishFileProposal,
  getFileProposals,
  getPendingFileProposals,
  getFileProposal,
  observeFileProposals,
  resolveFileProposal,
  fileProposalSizeViolation,
  FILE_PROPOSAL_LIMITS,
  getPendingRunGroups,
  markRunOpen,
  markRunClosed,
  readRunOpen,
  mintRunId,
  RUN_ID_MAX_LEN,
  RUN_GROUP_MAX,
  RECORDS_PER_RUN_MAX,
} from "./proposal-mailbox.js";
export type {
  ProposalInput,
  ProposalRecord,
  ProposalStatus,
  ProposalSigner,
} from "./proposal-mailbox.js";
export type {
  FileProposalInput,
  FileProposalRecord,
  FileProposalOp,
  RunGroup,
  PendingRunGroups,
  RunState,
} from "./proposal-mailbox.js";
// Proposal provenance (ADR-0023 §1): canonical signing serialization + the
// HKDF-derived per-grant key and HMAC sign/verify the auto-accept path uses to
// AUTHENTICATE a proposal before applying it without a human click.
export {
  proposalSigningBytes,
  deriveProposalKey,
  signProposal,
  verifyProposal,
  proposalSignedDigest,
  singleToSignable,
  fileToSignable,
} from "./proposal-provenance.js";
export type {
  ProposalScope,
  SignableProposal,
  SignableOp,
  SignableBinaryAsset,
} from "./proposal-provenance.js";
// Agent Access control mailbox (roadmap #16.3a, ADR-0021): bounded
// request/response RPC over the control room's doc — the kernel ASKS, the
// browser (the sole authority) DECIDES and answers.
export {
  publishControlRequest,
  readControlRequests,
  getControlRequest,
  publishControlResponse,
  getControlResponse,
  awaitControlResponse,
  withdrawControlRequest,
  observeControlRequests,
  pruneControlMailbox,
  controlRequestViolation,
  controlResponseViolation,
  controlResponseSigningString,
  hmacControlResponse,
  bytesToBase64Url,
  base64UrlToBytes,
  CONTROL_LIMITS,
  CONTROL_RESPONSE_KEY_BYTES,
} from "./control-mailbox.js";
export type {
  ControlParams,
  ControlRequestInput,
  ControlRequest,
  ControlResponseInput,
  ControlResponse,
} from "./control-mailbox.js";
// Pairing bootstrap (B2, ADR-0026): the pure crypto core of the durable kernel
// pairing handshake — HKDF room/keys from a one-time code, the claim-proof MAC,
// and the AES-256-GCM seal/open for the {syncUrl, controlRoom, responseKey} payload.
export {
  mintPairingCode,
  deriveBootstrap,
  generateEphemeralKeyPair,
  exportEphemeralPublic,
  deriveSealKey,
  computeClaimMac,
  verifyClaimMac,
  sealPairingPayload,
  openPairingPayload,
  PAIRING_CODE_BYTES,
  PAIRING_NONCE_BYTES,
  PAIRING_EPH_PUBLIC_BYTES,
} from "./pairing-bootstrap.js";
export type {
  PairingBootstrap,
  PairingPayload,
  PairingSealAad,
  SealedPairingPayload,
  ClaimContext,
  EphemeralKeyPair,
} from "./pairing-bootstrap.js";
export {
  sha256Hex,
  inferMime,
  assetEquals,
  InMemoryBlobStore,
} from "./binary-assets.js";
export type { BinaryAsset, BlobStore } from "./binary-assets.js";
// galley-blob-v1 byte-transport (Phase 1): the dedicated binary blob channel that
// carries content-addressed bytes between the browser and the MCP kernel WITHOUT
// bloating the Yjs CRDT log. This export is the PURE wire framing; the relay
// handler + client/kernel transports live in apps/sync, apps/web, apps/mcp.
export {
  encodeFrame,
  decodeFrame,
  peekFrameRouting,
  verifyBlob,
  concatChunks,
  planTransfer,
  isValidHash,
  isValidTransferId,
  isValidMime,
  expectedChunks,
  blobTerminalSigningBytes,
  deriveBlobTerminalKey,
  signBlobTerminal,
  verifyBlobTerminal,
  BlobProtocolError,
  FrameType,
  BLOB_CHUNK_BYTES,
  BLOB_MAX_TRANSFER_BYTES,
  BLOB_MAX_INFLIGHT_TRANSFERS,
  BLOB_ACK_WINDOW,
  BLOB_IDLE_TRANSFER_MS,
  BLOB_MAX_MIME_BYTES,
  BLOB_MAX_TRANSFER_ID_BYTES,
  BLOB_MAX_REASON_BYTES,
  BLOB_MAX_CHUNKS,
} from "./blob-protocol.js";
export type {
  BlobFrame,
  HeaderFrame,
  DataFrame,
  AckFrame,
  AbortFrame,
  CompleteFrame,
  FrameTypeValue,
  FrameRouting,
  BlobTerminalScope,
  BlobTerminalKind,
} from "./blob-protocol.js";
// Source-anchored threaded comments (Comments Phase A, Layer 1): a top-level
// `Y.Map("comments")` of relative-position-anchored threads. The data model +
// the pure `resolveAnchor`/`resolveThreadRange` render seam the editor decorations
// (Layer 2) and overview (Layer 5) build on. Comments NEVER reach the compiler.
export {
  getComments,
  createThread,
  createThreadAnchored,
  encodeAnchor,
  addMessage,
  setThreadStatus,
  getThreads,
  getThread,
  observeComments,
  resolveAnchor,
  resolveThreadRange,
  SINGLE_FILE_ID,
} from "./comments.js";
export type {
  Thread,
  ThreadView,
  Message,
  ThreadStatus,
  CreateThreadInput,
  CreateThreadAnchoredInput,
} from "./comments.js";
export { BlobTransport, buildBlobTerminalAuth } from "./blob-transport.js";
export type {
  BlobTransportOptions,
  ReceivedBlob,
  BlobSendHandle,
  BlobSendOptions,
  BlobExpectation,
  BlobTerminalSigner,
  BlobTerminalVerifier,
} from "./blob-transport.js";
// Blob-sync PLANNER (D1 "servable-provenance" split): the PURE decision core for
// online-only, server-less blob discovery over awareness. `planBlobDemand` uses the
// peer-writable snapshot ONLY to decide what bytes the requester needs; `planBlobServe`
// takes NO snapshot — the sole authorization to disclose bytes is a durable, device-local
// SERVABLE grant (`servableHeld`), closing the pre-Accept snapshot-exfiltration path.
export {
  planBlobDemand,
  planBlobServe,
  decodeWantList,
  BLOB_WANTS_FIELD,
  BLOB_WANT_BATCH_MAX,
} from "./blob-sync-planner.js";
export type { BlobPointer, BlobWantList, PeerBlobWant } from "./blob-sync-planner.js";
