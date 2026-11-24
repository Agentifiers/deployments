import { Ulid, type IdentityRecord, type IdentitySessionCursor } from "@deployments-ai/db";
import { IdentityError } from "@deployments-ai/identity";
import { Schema } from "effect";
import {
  matchingActiveLocator,
  revokeBrowserSession,
  type SessionRevocationDependencies,
} from "./session-revocation.ts";

const DEFAULT_SESSION_PAGE_LIMIT = 50;
const MAX_SESSION_PAGE_LIMIT = 100;
const MAX_CURSOR_LENGTH = 256;

const isUlid = Schema.is(Ulid);

/**
 * The caller's browser session as established by `IdentityApplication.session`, or the browser
 * session behind a console access token. `sessionId` marks which listed session is the caller's.
 */
export interface AuthenticatedBrowserSession {
  readonly principal: { readonly id: string };
  readonly sessionId: string;
}

export interface SessionManagementDependencies extends SessionRevocationDependencies {
  readonly authenticate: (rawToken: string) => Promise<AuthenticatedBrowserSession | undefined>;
}

export interface BrowserSessionSummary {
  readonly authenticationTime: string;
  readonly createdAt: string;
  readonly current: boolean;
  readonly deviceLabel?: string;
  readonly expiresAt: string;
  readonly id: string;
  readonly idleExpiresAt: string;
  readonly lastRefreshedAt: string;
}

export interface BrowserSessionPage {
  readonly items: readonly BrowserSessionSummary[];
  readonly nextCursor?: string;
}

export type BrowserSessionRevocation =
  | { readonly outcome: "not_found" }
  | { readonly outcome: "revoked"; readonly current: boolean };

function invalidRequest(message: string) {
  return new IdentityError("invalid_request", message, { exposeDescription: true });
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function encodeSessionCursor(cursor: IdentitySessionCursor) {
  return Buffer.from(JSON.stringify({ createdAt: cursor.createdAt, id: cursor.id })).toString(
    "base64url",
  );
}

function decodeSessionCursor(cursor: string): IdentitySessionCursor {
  const invalid = invalidRequest("Session cursor is invalid.");
  if (cursor.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw invalid;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw invalid;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid;
  const fields = parsed as Record<string, unknown>;
  if (
    Object.keys(fields).sort().join(",") !== "createdAt,id" ||
    !isCanonicalTimestamp(fields.createdAt) ||
    !isUlid(fields.id)
  ) {
    throw invalid;
  }
  const decoded = { createdAt: fields.createdAt, id: fields.id };
  // Reject alternate encodings of the same position so cursors stay opaque and canonical.
  if (encodeSessionCursor(decoded) !== cursor) throw invalid;
  return decoded;
}

function pageLimit(limit: number | undefined) {
  if (limit === undefined) return DEFAULT_SESSION_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SESSION_PAGE_LIMIT) {
    throw invalidRequest(`Session page limit must be between 1 and ${MAX_SESSION_PAGE_LIMIT}.`);
  }
  return limit;
}

function isUsable(record: IdentityRecord<"identity-session">, timestamp: number) {
  return (
    record.data.status === "active" &&
    Date.parse(record.data.expiresAt) > timestamp &&
    Date.parse(record.data.idleExpiresAt) > timestamp
  );
}

export function makeSessionManagementApplication(dependencies: SessionManagementDependencies) {
  const now = dependencies.now ?? (() => new Date());

  /**
   * Lists the caller's own browser sessions newest first. Storage keeps epoch-invalidated and
   * expired sessions `active` until TTL, so those are dropped here for display; pages can
   * therefore be shorter than `limit` while still carrying a `nextCursor`.
   */
  async function listSessions(
    rawToken: string,
    input: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<BrowserSessionPage | undefined> {
    const caller = rawToken ? await dependencies.authenticate(rawToken) : undefined;
    return caller ? listCallerSessions(caller, input) : undefined;
  }

  async function listCallerSessions(
    caller: AuthenticatedBrowserSession,
    input: { readonly cursor?: string; readonly limit?: number } = {},
  ): Promise<BrowserSessionPage> {
    const limit = pageLimit(input.limit);
    const before = input.cursor === undefined ? undefined : decodeSessionCursor(input.cursor);
    const principalId = caller.principal.id;
    const [page, securityState] = await Promise.all([
      dependencies.repository.listActiveSessions(principalId, {
        ...(before ? { before } : {}),
        limit,
      }),
      dependencies.repository.securityStateForPrincipal(principalId),
    ]);
    if (!securityState) return { items: [] };
    const timestamp = now().getTime();
    const items = page.items
      .filter(
        (record) =>
          record.data.principalId === principalId &&
          record.data.sessionEpoch === securityState.data.sessionEpoch &&
          isUsable(record, timestamp),
      )
      .map(
        (record): BrowserSessionSummary => ({
          authenticationTime: record.data.authenticationTime,
          createdAt: record.data.createdAt,
          current: record.data.id === caller.sessionId,
          ...(record.data.deviceLabel ? { deviceLabel: record.data.deviceLabel } : {}),
          expiresAt: record.data.expiresAt,
          id: record.data.id,
          idleExpiresAt: record.data.idleExpiresAt,
          lastRefreshedAt: record.data.lastRefreshedAt,
        }),
      );
    return { items, ...(page.next ? { nextCursor: encodeSessionCursor(page.next) } : {}) };
  }

  /**
   * Revokes one of the caller's browser sessions. Locators are partitioned by principal, so a
   * session id belonging to anyone else is indistinguishable from an unknown id.
   */
  async function revokeSession(
    rawToken: string,
    sessionId: string,
  ): Promise<BrowserSessionRevocation | undefined> {
    const caller = rawToken ? await dependencies.authenticate(rawToken) : undefined;
    return caller ? revokeCallerSession(caller, sessionId) : undefined;
  }

  async function revokeCallerSession(
    caller: AuthenticatedBrowserSession,
    sessionId: string,
  ): Promise<BrowserSessionRevocation> {
    if (!isUlid(sessionId)) throw invalidRequest("Session id must be a canonical ULID.");
    const principalId = caller.principal.id;
    const firstLocator = await dependencies.repository.sessionLocator(principalId, sessionId);
    if (
      !firstLocator ||
      firstLocator.data.principalId !== principalId ||
      firstLocator.data.sessionId !== sessionId
    ) {
      return { outcome: "not_found" };
    }
    let pendingLocator: typeof firstLocator | undefined = firstLocator;
    await revokeBrowserSession(dependencies, async () => {
      const locator =
        pendingLocator ?? (await dependencies.repository.sessionLocator(principalId, sessionId));
      pendingLocator = undefined;
      if (locator?.data.status !== "active") return undefined;
      const session = await dependencies.repository.sessionForHash(locator.data.sessionTokenHash);
      if (
        !session ||
        session.data.id !== sessionId ||
        session.data.principalId !== principalId ||
        !isUsable(session, now().getTime())
      ) {
        return undefined;
      }
      return { locator: matchingActiveLocator(session, locator), session };
    });
    return { current: sessionId === caller.sessionId, outcome: "revoked" };
  }

  return { listCallerSessions, listSessions, revokeCallerSession, revokeSession };
}
