import { StreamContractError } from "./errors.ts";
import { sameThreadStreamScope, type ThreadStreamScope } from "./paths.ts";

export const THREAD_STREAM_EVENT_TYPES = [
  "user-message.accepted",
  "assistant-token.chunk",
  "assistant-message.finalized",
  "agent.plan.updated",
  "agent.task.updated",
  "run.started",
  "run.progress",
  "run.completed",
  "run.failed",
  "run.canceled",
  "tool.requested",
  "tool.policy-decided",
  "tool.running",
  "tool.completed",
  "tool.failed",
  "approval.requested",
  "approval.resolved",
  "artifact.available",
  "stream.closed",
] as const;

export type ThreadStreamEventType = (typeof THREAD_STREAM_EVENT_TYPES)[number] | (string & {});

type ThreadStreamCorrelationField =
  | "approvalId"
  | "artifactId"
  | "messageId"
  | "runId"
  | "toolCallId";

const THREAD_STREAM_EVENT_REQUIRED_FIELDS: Readonly<
  Record<string, readonly ThreadStreamCorrelationField[] | undefined>
> = {
  "approval.requested": ["approvalId", "runId"],
  "approval.resolved": ["approvalId", "runId"],
  "agent.plan.updated": ["runId"],
  "agent.task.updated": ["runId"],
  "artifact.available": ["artifactId", "runId"],
  "assistant-message.finalized": ["messageId", "runId"],
  "assistant-token.chunk": ["messageId", "runId"],
  "run.canceled": ["runId"],
  "run.completed": ["runId"],
  "run.failed": ["runId"],
  "run.progress": ["runId"],
  "run.started": ["runId"],
  "tool.completed": ["runId", "toolCallId"],
  "tool.failed": ["runId", "toolCallId"],
  "tool.policy-decided": ["runId", "toolCallId"],
  "tool.requested": ["runId", "toolCallId"],
  "tool.running": ["runId", "toolCallId"],
  "user-message.accepted": ["messageId", "runId"],
};

export interface ThreadStreamActor {
  readonly id?: string;
  readonly type: "agent" | "service" | "system" | "user" | "worker";
}

export interface ThreadStreamEvent extends ThreadStreamScope {
  readonly actor?: ThreadStreamActor;
  readonly approvalId?: string;
  readonly artifactId?: string;
  readonly eventId: string;
  readonly eventType: ThreadStreamEventType;
  readonly messageId?: string;
  readonly occurredAt: string;
  readonly payload: unknown;
  readonly runId?: string;
  readonly toolCallId?: string;
}

export type CreateThreadStreamEventInput = Omit<ThreadStreamEvent, "occurredAt"> & {
  readonly occurredAt?: Date | string;
};

function requiredString(field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new StreamContractError(field, `${field} is required.`);
  }
  return value.trim();
}

function optionalString(field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(field, value);
}

function occurredAt(value: Date | string | undefined): string {
  const normalized =
    value instanceof Date
      ? value.toISOString()
      : requiredString("occurredAt", value ?? new Date().toISOString());
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new StreamContractError("occurredAt", "occurredAt must be an ISO-compatible timestamp.");
  }
  return normalized;
}

function actor(value: unknown): ThreadStreamActor | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StreamContractError("actor", "actor must be an object.");
  }
  const record = value as Record<string, unknown>;
  const type = requiredString("actor.type", record.type);
  if (!["agent", "service", "system", "user", "worker"].includes(type)) {
    throw new StreamContractError("actor.type", "actor.type is not supported.");
  }
  return {
    type: type as ThreadStreamActor["type"],
    ...(optionalString("actor.id", record.id)
      ? { id: optionalString("actor.id", record.id)! }
      : {}),
  };
}

function jsonPayload(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("payload was omitted");
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new StreamContractError(
      "payload",
      "Thread stream event payload must be JSON-compatible.",
    );
  }
}

function isPayloadRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Chunk payloads carry `{ modelCallId, sequence, text }`. `modelCallId` is the identity of one
 * streamed generation attempt; it includes the run attempt, which increments on every claim, so a
 * requeued execution always streams under a new id. Consumers only compare it for equality, and a
 * new value supersedes earlier partial text. `sequence` is 0-based within that identity.
 */
function assertKnownEventPayload(eventType: string, payload: unknown): void {
  if (eventType !== "assistant-token.chunk") return;
  const chunk = isPayloadRecord(payload) ? payload : {};
  if (typeof chunk.modelCallId !== "string" || !chunk.modelCallId.trim()) {
    throw new StreamContractError(
      "payload.modelCallId",
      "assistant-token.chunk requires a non-empty modelCallId.",
    );
  }
  if (!Number.isSafeInteger(chunk.sequence) || Number(chunk.sequence) < 0) {
    throw new StreamContractError(
      "payload.sequence",
      "assistant-token.chunk requires a non-negative integer sequence.",
    );
  }
  if (typeof chunk.text !== "string") {
    throw new StreamContractError("payload.text", "assistant-token.chunk requires text.");
  }
}

function normalizeThreadStreamEvent(input: CreateThreadStreamEventInput): ThreadStreamEvent {
  if (input.payload === undefined) {
    throw new StreamContractError("payload", "Thread stream event payload is required.");
  }
  const event: ThreadStreamEvent = {
    environmentId: requiredString("environmentId", input.environmentId),
    eventId: requiredString("eventId", input.eventId),
    eventType: requiredString("eventType", input.eventType),
    occurredAt: occurredAt(input.occurredAt),
    organizationId: requiredString("organizationId", input.organizationId),
    payload: jsonPayload(input.payload),
    projectId: requiredString("projectId", input.projectId),
    threadId: requiredString("threadId", input.threadId),
    ...(input.actor ? { actor: actor(input.actor)! } : {}),
    ...(input.approvalId ? { approvalId: requiredString("approvalId", input.approvalId) } : {}),
    ...(input.artifactId ? { artifactId: requiredString("artifactId", input.artifactId) } : {}),
    ...(input.messageId ? { messageId: requiredString("messageId", input.messageId) } : {}),
    ...(input.runId ? { runId: requiredString("runId", input.runId) } : {}),
    ...(input.toolCallId ? { toolCallId: requiredString("toolCallId", input.toolCallId) } : {}),
  };
  for (const field of THREAD_STREAM_EVENT_REQUIRED_FIELDS[event.eventType] ?? []) {
    if (!event[field]) {
      throw new StreamContractError(
        field,
        `${event.eventType} requires the ${field} correlation identifier.`,
      );
    }
  }
  assertKnownEventPayload(event.eventType, event.payload);
  return event;
}

export function createThreadStreamEvent(input: CreateThreadStreamEventInput): ThreadStreamEvent {
  return normalizeThreadStreamEvent(input);
}

export function parseThreadStreamEvent(value: unknown): ThreadStreamEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StreamContractError("event", "Thread stream event must be an object.");
  }
  const record = value as Record<string, unknown>;
  const parsedActor = actor(record.actor);
  const approvalId = optionalString("approvalId", record.approvalId);
  const artifactId = optionalString("artifactId", record.artifactId);
  const messageId = optionalString("messageId", record.messageId);
  const runId = optionalString("runId", record.runId);
  const toolCallId = optionalString("toolCallId", record.toolCallId);
  return normalizeThreadStreamEvent({
    environmentId: requiredString("environmentId", record.environmentId),
    eventId: requiredString("eventId", record.eventId),
    eventType: requiredString("eventType", record.eventType),
    occurredAt: requiredString("occurredAt", record.occurredAt),
    organizationId: requiredString("organizationId", record.organizationId),
    payload: record.payload,
    projectId: requiredString("projectId", record.projectId),
    threadId: requiredString("threadId", record.threadId),
    ...(parsedActor ? { actor: parsedActor } : {}),
    ...(approvalId ? { approvalId } : {}),
    ...(artifactId ? { artifactId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(runId ? { runId } : {}),
    ...(toolCallId ? { toolCallId } : {}),
  });
}

export function parseThreadStreamEventJson(json: string): ThreadStreamEvent {
  return parseThreadStreamEvent(JSON.parse(json) as unknown);
}

export function threadStreamEventJson(event: ThreadStreamEvent): string {
  return JSON.stringify(createThreadStreamEvent(event));
}

export function assertEventsMatchThreadScope(
  scope: ThreadStreamScope,
  events: readonly ThreadStreamEvent[],
): readonly ThreadStreamEvent[] {
  for (const event of events) {
    if (!sameThreadStreamScope(scope, event)) {
      throw new StreamContractError(
        "event.scope",
        "Thread stream event does not belong to the target thread scope.",
      );
    }
  }
  return events;
}

export interface ThreadStreamReplayState {
  readonly canonicalMessageIds?: readonly string[];
  readonly eventIds?: readonly string[];
  readonly finalizedMessageIds: readonly string[];
  readonly historyThroughSequence?: number;
}

export interface ThreadStreamDeduplicatorOptions {
  readonly maxEventIds?: number;
  readonly maxMessageIds?: number;
  readonly maxSeedMessageIds?: number;
}

const DEFAULT_MAX_REPLAY_EVENT_IDS = 8_192;
const DEFAULT_MAX_REPLAY_MESSAGE_IDS = 2_048;
const DEFAULT_MAX_REPLAY_SEED_MESSAGE_IDS = 10_000;

function replayLimit(field: string, value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new StreamContractError(field, `${field} must be a positive integer.`);
  }
  return limit;
}

function addBounded(values: Set<string>, value: string, maximum: number): void {
  if (values.has(value)) return;
  values.add(value);
  while (values.size > maximum) {
    const oldest = values.values().next().value as string | undefined;
    if (oldest === undefined) break;
    values.delete(oldest);
  }
}

function mergeSeedPreservingLive(live: Set<string>, seed: Set<string>, maximum: number): void {
  const liveValues = [...live];
  live.clear();
  for (const value of seed) addBounded(live, value, maximum);
  for (const value of liveValues) addBounded(live, value, maximum);
  seed.clear();
}

export class ThreadStreamDeduplicator {
  readonly #canonicalMessageIds = new Set<string>();
  readonly #eventIds = new Set<string>();
  readonly #finalizedMessageIds = new Set<string>();
  readonly #maxEventIds: number;
  readonly #maxMessageIds: number;
  readonly #maxSeedMessageIds: number;
  #historyThroughSequence: number | undefined;
  readonly #seedCanonicalMessageIds = new Set<string>();
  readonly #seedFinalizedMessageIds = new Set<string>();

  constructor(seed?: ThreadStreamReplayState, options: ThreadStreamDeduplicatorOptions = {}) {
    this.#maxEventIds = replayLimit(
      "maxEventIds",
      options.maxEventIds,
      DEFAULT_MAX_REPLAY_EVENT_IDS,
    );
    this.#maxMessageIds = replayLimit(
      "maxMessageIds",
      options.maxMessageIds,
      DEFAULT_MAX_REPLAY_MESSAGE_IDS,
    );
    this.#maxSeedMessageIds = replayLimit(
      "maxSeedMessageIds",
      options.maxSeedMessageIds,
      DEFAULT_MAX_REPLAY_SEED_MESSAGE_IDS,
    );
    if (seed) this.seed(seed);
  }

  seed(seed: ThreadStreamReplayState): void {
    if (seed.historyThroughSequence !== undefined) {
      if (!Number.isSafeInteger(seed.historyThroughSequence) || seed.historyThroughSequence < 0) {
        throw new StreamContractError(
          "seed.historyThroughSequence",
          "Replay history sequence must be a non-negative safe integer.",
        );
      }
      this.#historyThroughSequence = Math.max(
        this.#historyThroughSequence ?? 0,
        seed.historyThroughSequence,
      );
    }
    for (const eventId of seed.eventIds ?? []) {
      addBounded(this.#eventIds, eventId, this.#maxEventIds);
    }
    for (const messageId of seed.canonicalMessageIds ?? []) {
      this.#seedCanonicalMessageIds.add(messageId);
      if (this.#seedCanonicalMessageIds.size > this.#maxSeedMessageIds) {
        throw new StreamContractError(
          "seed.canonicalMessageIds",
          `Replay seed exceeds the ${this.#maxSeedMessageIds}-message limit.`,
        );
      }
    }
    for (const messageId of seed.finalizedMessageIds) {
      this.#seedFinalizedMessageIds.add(messageId);
      if (this.#seedFinalizedMessageIds.size > this.#maxSeedMessageIds) {
        throw new StreamContractError(
          "seed.finalizedMessageIds",
          `Replay seed exceeds the ${this.#maxSeedMessageIds}-message limit.`,
        );
      }
    }
  }

  markUpToDate(): void {
    mergeSeedPreservingLive(
      this.#canonicalMessageIds,
      this.#seedCanonicalMessageIds,
      this.#maxMessageIds,
    );
    mergeSeedPreservingLive(
      this.#finalizedMessageIds,
      this.#seedFinalizedMessageIds,
      this.#maxMessageIds,
    );
  }

  accept(event: ThreadStreamEvent): boolean {
    if (this.#eventIds.has(event.eventId)) return false;
    // Token chunks are live-only: replayed history never covers them, so only duplicate event ids
    // and finalization of their message drop them.
    const sequence = isPayloadRecord(event.payload) ? event.payload.sequence : undefined;
    if (
      (event.eventType === "user-message.accepted" ||
        event.eventType === "assistant-message.finalized") &&
      Number.isSafeInteger(sequence) &&
      this.#historyThroughSequence !== undefined &&
      Number(sequence) <= this.#historyThroughSequence
    ) {
      addBounded(this.#eventIds, event.eventId, this.#maxEventIds);
      return false;
    }
    if (
      event.messageId &&
      (this.#canonicalMessageIds.has(event.messageId) ||
        this.#seedCanonicalMessageIds.has(event.messageId)) &&
      (event.eventType === "user-message.accepted" ||
        event.eventType === "assistant-message.finalized")
    ) {
      addBounded(this.#eventIds, event.eventId, this.#maxEventIds);
      return false;
    }
    if (
      event.messageId &&
      (this.#finalizedMessageIds.has(event.messageId) ||
        this.#seedFinalizedMessageIds.has(event.messageId)) &&
      (event.eventType === "assistant-token.chunk" ||
        event.eventType === "assistant-message.finalized")
    ) {
      addBounded(this.#eventIds, event.eventId, this.#maxEventIds);
      return false;
    }
    addBounded(this.#eventIds, event.eventId, this.#maxEventIds);
    if (event.eventType === "user-message.accepted" && event.messageId) {
      addBounded(this.#canonicalMessageIds, event.messageId, this.#maxMessageIds);
    }
    if (event.eventType === "assistant-message.finalized" && event.messageId) {
      addBounded(this.#canonicalMessageIds, event.messageId, this.#maxMessageIds);
      addBounded(this.#finalizedMessageIds, event.messageId, this.#maxMessageIds);
    }
    return true;
  }
}
