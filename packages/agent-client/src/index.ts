/**
 * @galley/agent-client — the headless draft-publisher client.
 *
 * Join a shared project's room over the sync relay as an agent peer and park
 * UNSIGNED proposals in the `@galley/collab` mailbox behind the browser's
 * manual in-editor Accept gate: connect → publish → flush → disconnect.
 * `flush()` proves the records were APPLIED TO THE LIVE RELAY ROOM — delivery,
 * not persistence: the relay holds no storage and reaps a room's doc on last
 * disconnect, so a delivered record survives only while some peer (the editor
 * side, in the A2 topology) keeps the room open.
 * Generic by design (a self-hoster's CI bot lands drafts with it the same way
 * a cloud document sink does); the record/limit contracts are re-exported from
 * `@galley/collab` so a consumer needs only this package.
 */
export {
  connectDraftPublisher,
  DRAFT_PUBLISHER_RUN_ID,
} from "./draft-publisher.js";
export type {
  DraftPublisher,
  DraftPublisherConfig,
  DraftPublisherOptions,
} from "./draft-publisher.js";
// The mailbox contract a publisher speaks (inputs, records, size caps).
export {
  PROPOSAL_LIMITS,
  FILE_PROPOSAL_LIMITS,
  RUN_ID_MAX_LEN,
} from "@galley/collab";
export type {
  ProposalInput,
  ProposalRecord,
  ProposalStatus,
  FileProposalInput,
  FileProposalRecord,
  FileProposalOp,
} from "@galley/collab";
