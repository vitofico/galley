/**
 * Hosted-connector token POLICY (ADR-0033 §3) — issuing, listing, revoking and
 * checking the tokens a client presents at `/mcp`. Framework-agnostic: the
 * Hono wiring lives in `apps/web-server/src/auth-router.ts`, the check is
 * called by the connector service.
 *
 * What is stored is the token's SHA-256, never the token. The token is 32
 * random bytes, so a fast hash is the right one: there is no low-entropy
 * secret to stretch, and the check runs on every request.
 *
 * Inputs to the three management functions arrive PRE-AUTHENTICATED (a valid
 * session, same-origin). Failures are constant `{ ok: false, code }` shapes,
 * and revoke answers identically for "no such token" and "not yours".
 */
import {
  CONNECTOR_TOKEN_PREFIX,
  isActiveConnectorToken,
  isConnectorToken,
  isConnectorTokenId,
  type ConnectorTokenRecord,
  type ConnectorTokenStore,
} from "@galley/shared";
import { randomToken, type RandomSource } from "./oidc-core.js";

/** Max live tokens one account may hold (one per client is the intent). */
export const MAX_ACTIVE_CONNECTOR_TOKENS_PER_USER = 16;
/** The lifetimes a person may pick, in days. The first is the default. */
export const CONNECTOR_TOKEN_LIFETIMES_DAYS = [90, 30, 365] as const;
const MAX_TOKEN_NAME_LENGTH = 64;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A token as its owner may see it after creation: everything but the secret. */
export interface ConnectorTokenInfo {
  tokenId: string;
  name: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export type ConnectorTokenErrorCode = "invalid" | "unknown" | "cap-exceeded";

export type CreateConnectorTokenResult =
  | {
      status: 200;
      /** `token` is returned here ONCE and exists nowhere else afterwards. */
      body: { ok: true; token: string } & ConnectorTokenInfo;
    }
  | { status: 400 | 409; body: { ok: false; code: ConnectorTokenErrorCode } };

export type RevokeConnectorTokenResult =
  | { status: 200; body: { ok: true } }
  | { status: 404; body: { ok: false; code: "unknown" } };

/** Hex SHA-256 of a token: its storage key. */
export async function hashConnectorToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

const info = (r: ConnectorTokenRecord): ConnectorTokenInfo => ({
  tokenId: r.tokenId,
  name: r.name,
  createdAtMs: r.createdAtMs,
  expiresAtMs: r.expiresAtMs,
});

/** The caller's live tokens, oldest first. Expired ones are dropped on the way. */
async function liveTokens(
  store: ConnectorTokenStore,
  userId: string,
  nowMs: number,
): Promise<ConnectorTokenRecord[]> {
  const mine = (await store.list()).filter((r) => r.createdBy === userId);
  const live: ConnectorTokenRecord[] = [];
  for (const r of mine) {
    if (isActiveConnectorToken(r, nowMs)) live.push(r);
    else await store.remove(r.hash).catch(() => undefined); // housekeeping only
  }
  return live.sort((a, b) => a.createdAtMs - b.createdAtMs);
}

export async function listConnectorTokens(
  store: ConnectorTokenStore,
  userId: string,
  nowMs: number,
): Promise<ConnectorTokenInfo[]> {
  return (await liveTokens(store, userId, nowMs)).map(info);
}

export interface CreateConnectorTokenInput {
  /** The parsed JSON request body (UNTRUSTED): `{ name, expiresInDays? }`. */
  body: unknown;
  userId: string;
  nowMs: number;
  random?: RandomSource;
}

/**
 * Issue a token. The name is the person's label for the client; the lifetime
 * is one of {@link CONNECTOR_TOKEN_LIFETIMES_DAYS}. Not serialized per user:
 * two racing creates can overshoot the cap by one, which costs nothing.
 */
export async function createConnectorToken(
  store: ConnectorTokenStore,
  input: CreateConnectorTokenInput,
): Promise<CreateConnectorTokenResult> {
  const invalid = {
    status: 400,
    body: { ok: false, code: "invalid" },
  } as const;
  if (typeof input.body !== "object" || input.body === null) return invalid;
  const { name, expiresInDays = CONNECTOR_TOKEN_LIFETIMES_DAYS[0] } =
    input.body as Record<string, unknown>;
  if (
    typeof name !== "string" ||
    name.trim().length === 0 ||
    name.length > MAX_TOKEN_NAME_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    !CONNECTOR_TOKEN_LIFETIMES_DAYS.includes(expiresInDays as 90)
  )
    return invalid;
  const live = await liveTokens(store, input.userId, input.nowMs);
  if (live.length >= MAX_ACTIVE_CONNECTOR_TOKENS_PER_USER)
    return { status: 409, body: { ok: false, code: "cap-exceeded" } };

  const token = CONNECTOR_TOKEN_PREFIX + randomToken(input.random);
  const record: ConnectorTokenRecord = {
    version: 1,
    tokenId: randomToken(input.random, 12),
    hash: await hashConnectorToken(token),
    createdBy: input.userId,
    name: name.trim(),
    createdAtMs: input.nowMs,
    expiresAtMs: input.nowMs + (expiresInDays as number) * DAY_MS,
  };
  await store.put(record);
  return { status: 200, body: { ok: true, token, ...info(record) } };
}

/** Revoke one of the caller's tokens: its record is deleted, so it stops working at once. */
export async function revokeConnectorToken(
  store: ConnectorTokenStore,
  input: { tokenId: string; userId: string },
): Promise<RevokeConnectorTokenResult> {
  const unknown = {
    status: 404,
    body: { ok: false, code: "unknown" },
  } as const;
  if (!isConnectorTokenId(input.tokenId)) return unknown;
  const record = (await store.list()).find(
    (r) => r.tokenId === input.tokenId && r.createdBy === input.userId,
  );
  if (record === undefined) return unknown;
  await store.remove(record.hash);
  return { status: 200, body: { ok: true } };
}

/**
 * Check a presented token (UNTRUSTED). Resolves the account it acts for and
 * its public id, or null for anything else: malformed, unknown, expired,
 * revoked. The caller still decides what that account may touch.
 */
export async function verifyConnectorToken(
  store: ConnectorTokenStore,
  token: unknown,
  nowMs: number,
): Promise<{ userId: string; tokenId: string } | null> {
  if (!isConnectorToken(token)) return null;
  const hash = await hashConnectorToken(token);
  const record = await store.get(hash);
  if (record === null || record.hash !== hash) return null;
  if (!isActiveConnectorToken(record, nowMs)) return null;
  return { userId: record.createdBy, tokenId: record.tokenId };
}
