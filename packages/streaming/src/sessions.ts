import { StreamContractError, StreamSessionExpiredError } from "./errors.ts";
import type { ThreadStreamReplayState } from "./events.ts";
import { sameThreadStreamScope, threadStreamPath, type ThreadStreamScope } from "./paths.ts";
import type { DurableStreamTransport } from "./transport.ts";

export interface ThreadStreamSessionClaims extends ThreadStreamScope {
  readonly expiresAt: string;
  readonly permissions: readonly ("append" | "read")[];
  readonly sessionId: string;
}

export interface ThreadStreamSession extends ThreadStreamSessionClaims {
  readonly offset: string;
  readonly readUrl: string;
  readonly replayState: ThreadStreamReplayState;
}

export interface ThreadHistoryPage<Message> {
  readonly items: readonly Message[];
  readonly nextCursor?: string;
  readonly snapshotUpperSk?: string;
}

export interface CreateThreadSessionInput<Message> {
  readonly canonicalMessageId: (message: Message) => string | undefined;
  readonly claims: ThreadStreamSessionClaims;
  readonly createReadUrl: (offset: string, scope: ThreadStreamScope) => string;
  readonly finalizedMessageId: (message: Message) => string | undefined;
  readonly historyItemBytes: (message: Message) => number;
  readonly historyMode?: "complete" | "page";
  readonly maxHistoryBytes?: number;
  readonly maxHistoryItems?: number;
  readonly maxHistoryPages?: number;
  readonly now?: () => number;
  readonly replaySeedMode?: "complete" | "history-page";
  readonly readHistoryPage: (
    scope: ThreadStreamScope,
    cursor?: string,
  ) => Promise<ThreadHistoryPage<Message>>;
  readonly scope: ThreadStreamScope;
  readonly transport: DurableStreamTransport;
}

const DEFAULT_MAX_HISTORY_PAGES = 100;
const DEFAULT_MAX_HISTORY_ITEMS = 10_000;
const DEFAULT_MAX_HISTORY_BYTES = 4 * 1024 * 1024;

function positiveLimit(field: string, value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new StreamContractError(field, `${field} must be a positive integer.`);
  }
  return limit;
}

export function threadHistoryReplayState<Message>(
  history: ThreadHistoryPage<Message>,
  canonicalMessageId: (message: Message) => string | undefined,
  finalizedMessageId: (message: Message) => string | undefined,
): ThreadStreamReplayState {
  const normalizedIds = (selector: (message: Message) => string | undefined): readonly string[] => [
    ...new Set(
      history.items
        .map(selector)
        .filter((messageId): messageId is string => Boolean(messageId?.trim()))
        .map((messageId) => messageId.trim()),
    ),
  ];
  return {
    canonicalMessageIds: normalizedIds(canonicalMessageId),
    finalizedMessageIds: normalizedIds(finalizedMessageId),
  };
}

function validExpiration(expiresAt: string): number {
  const timestamp = Date.parse(expiresAt);
  if (!Number.isFinite(timestamp)) {
    throw new StreamContractError(
      "expiresAt",
      "Stream session expiration must be a valid timestamp.",
    );
  }
  return timestamp;
}

export function assertActiveThreadStreamSession(
  claims: ThreadStreamSessionClaims,
  requestedScope: ThreadStreamScope,
  permission: "append" | "read",
  now = Date.now(),
): void {
  if (!sameThreadStreamScope(claims, requestedScope)) {
    throw new StreamContractError(
      "session.scope",
      "Stream session does not match the requested thread scope.",
    );
  }
  if (!claims.permissions.includes(permission)) {
    throw new StreamContractError(
      "session.permissions",
      `Stream session does not permit ${permission}.`,
    );
  }
  if (validExpiration(claims.expiresAt) <= now)
    throw new StreamSessionExpiredError(claims.expiresAt);
}

export async function createOffsetBeforeHistorySession<Message>(
  input: CreateThreadSessionInput<Message>,
): Promise<{
  readonly history: ThreadHistoryPage<Message>;
  readonly session: ThreadStreamSession;
}> {
  const currentTime = (): number => input.now?.() ?? Date.now();
  assertActiveThreadStreamSession(input.claims, input.scope, "read", currentTime());
  const streamPath = threadStreamPath(input.scope);
  const offset = await input.transport.currentOffset(streamPath);
  const maximumPages = positiveLimit(
    "maxHistoryPages",
    input.maxHistoryPages,
    DEFAULT_MAX_HISTORY_PAGES,
  );
  const maximumItems = positiveLimit(
    "maxHistoryItems",
    input.maxHistoryItems,
    DEFAULT_MAX_HISTORY_ITEMS,
  );
  const maximumBytes = positiveLimit(
    "maxHistoryBytes",
    input.maxHistoryBytes,
    DEFAULT_MAX_HISTORY_BYTES,
  );
  const items: Message[] = [];
  const replayCanonicalMessageIds = new Set<string>();
  const replayFinalizedMessageIds = new Set<string>();
  let historyBytes = 0;
  let historyNextCursor: string | undefined;
  let replayItemCount = 0;
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let pageIndex = 0; ; pageIndex += 1) {
    if (pageIndex >= maximumPages) {
      throw new StreamContractError(
        "history.nextCursor",
        `Stream session history exceeded the ${maximumPages}-page limit.`,
      );
    }
    const page = await input.readHistoryPage(input.scope, cursor);
    if (replayItemCount + page.items.length > maximumItems) {
      throw new StreamContractError(
        "history.items",
        `Stream session history exceeded the ${maximumItems}-item limit.`,
      );
    }
    replayItemCount += page.items.length;
    const includeInHistory = input.historyMode !== "page" || pageIndex === 0;
    for (const item of page.items) {
      const canonicalMessageId = input.canonicalMessageId(item)?.trim();
      if (canonicalMessageId) replayCanonicalMessageIds.add(canonicalMessageId);
      const finalizedMessageId = input.finalizedMessageId(item)?.trim();
      if (finalizedMessageId) replayFinalizedMessageIds.add(finalizedMessageId);
      if (includeInHistory) {
        const itemBytes = input.historyItemBytes(item);
        if (!Number.isSafeInteger(itemBytes) || itemBytes < 0) {
          throw new StreamContractError(
            "history.itemBytes",
            "Stream session history item byte sizes must be non-negative safe integers.",
          );
        }
        historyBytes += itemBytes;
        if (!Number.isSafeInteger(historyBytes) || historyBytes > maximumBytes) {
          throw new StreamContractError(
            "history.bytes",
            `Stream session history exceeded the ${maximumBytes}-byte limit.`,
          );
        }
        items.push(item);
      }
    }
    if (page.nextCursor === undefined) break;
    const nextCursor = page.nextCursor.trim();
    if (!nextCursor) {
      throw new StreamContractError(
        "history.nextCursor",
        "Stream session history returned an empty next cursor.",
      );
    }
    if (seenCursors.has(nextCursor)) {
      throw new StreamContractError(
        "history.nextCursor",
        "Stream session history returned a repeated next cursor.",
      );
    }
    if (input.historyMode === "page") {
      historyNextCursor ??= nextCursor;
      if (input.replaySeedMode !== "complete") break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }
  const history: ThreadHistoryPage<Message> = {
    items,
    ...(historyNextCursor ? { nextCursor: historyNextCursor } : {}),
  };
  const replayState: ThreadStreamReplayState = {
    canonicalMessageIds: [...replayCanonicalMessageIds],
    finalizedMessageIds: [...replayFinalizedMessageIds],
  };
  assertActiveThreadStreamSession(input.claims, input.scope, "read", currentTime());
  return {
    history,
    session: {
      ...input.claims,
      offset,
      readUrl: input.createReadUrl(offset, input.scope),
      replayState,
    },
  };
}
