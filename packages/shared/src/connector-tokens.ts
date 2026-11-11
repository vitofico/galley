/**
 * Hosted-connector token contracts (ADR-0033 §3).
 *
 * A TOKEN belongs to one client (a chat app, a script). It reaches the
 * projects its account connected and nothing else, has an expiry, is shown
 * once, and is stored only as its SHA-256: the server can recognize a token
 * it is handed, never reproduce one. Types + pure predicates only (the
 * `@galley/shared` rule); issuing and checking live in `@galley/auth`, the
 * durable store in `@galley/persistence`.
 */

/** Every token starts with this, so a leaked one is recognizable in a scan. */
export const CONNECTOR_TOKEN_PREFIX = "gly_";

/** The shape of a token as presented: the prefix + 32 random bytes, base64url. */
export function isConnectorToken(value: unknown): value is string {
  return typeof value === "string" && /^gly_[A-Za-z0-9_-]{43}$/.test(value);
}

/** A token's public id: safe to list, log and put in an audit entry. */
export function isConnectorTokenId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16}$/.test(value);
}

/** The hex SHA-256 a token is stored and looked up under (also its FILENAME). */
export function isConnectorTokenHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/** One stored token. The token itself is never in it. */
export interface ConnectorTokenRecord {
  version: 1;
  tokenId: string;
  /** Hex SHA-256 of the token. */
  hash: string;
  /** The account the token acts for. */
  createdBy: string;
  /** The person's own label for the client holding it ("Claude chat"). */
  name: string;
  createdAtMs: number;
  expiresAtMs: number;
}

/**
 * Whether a stored token is usable at `nowMs`: structurally valid (a garbage
 * file on the volume must never authorize anything) and not expired. A revoked
 * token has no record at all.
 */
export function isActiveConnectorToken(
  record: ConnectorTokenRecord,
  nowMs: number,
): boolean {
  return (
    record.version === 1 &&
    isConnectorTokenId(record.tokenId) &&
    isConnectorTokenHash(record.hash) &&
    typeof record.createdBy === "string" &&
    record.createdBy.length > 0 &&
    typeof record.expiresAtMs === "number" &&
    Number.isFinite(record.expiresAtMs) &&
    record.expiresAtMs > nowMs
  );
}

/**
 * The durable token store. Keyed by HASH, so checking a presented token is one
 * read. Implementations MUST validate the hash with
 * {@link isConnectorTokenHash} before any storage access (it is a filename).
 */
export interface ConnectorTokenStore {
  get(hash: string): Promise<ConnectorTokenRecord | null>;
  put(record: ConnectorTokenRecord): Promise<void>;
  list(): Promise<ConnectorTokenRecord[]>;
  remove(hash: string): Promise<void>;
}
