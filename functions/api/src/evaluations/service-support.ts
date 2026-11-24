import {
  internalSemanticEventPayload,
  Ulid,
  type EvaluationPersistence,
  type EvaluationPersistenceEvent,
  type EvaluationScope,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { failure } from "../persistence-failure.ts";
import type {
  EvaluationApiInvocation,
  EvaluationApiServiceDependencies,
  EvaluationQueue,
} from "./service-contracts.ts";

/** A handled API failure that is not a persistence error (for example 503 unavailability). */
export class EvaluationApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "EvaluationApiProblem";
  }
}

const decodeUlid = Schema.decodeUnknownSync(Ulid);
const isUlid = Schema.is(Ulid);

export function ulid(value: string): Ulid {
  return decodeUlid(value);
}

/** Per-request context shared by the evaluation route handlers. */
export interface EvaluationRequestContext {
  readonly dependencies: EvaluationApiServiceDependencies;
  readonly invocation: EvaluationApiInvocation;
  readonly persistence: EvaluationPersistence;
  readonly principalId: string;
  readonly scope: EvaluationScope;
  readonly timestamp: string;
  readonly newId: () => Promise<Ulid>;
}

export function evaluationRequestContext(
  dependencies: EvaluationApiServiceDependencies,
  invocation: EvaluationApiInvocation,
): EvaluationRequestContext {
  return {
    dependencies,
    invocation,
    newId: async () => ulid(await dependencies.generateId()),
    persistence: dependencies.persistence(invocation.scope),
    principalId: invocation.identity.principalId,
    scope: invocation.scope,
    timestamp: dependencies.now?.() ?? new Date().toISOString(),
  };
}

export function requiredParam(context: EvaluationRequestContext, name: string): string {
  return (
    context.invocation.params[name] ??
    failure("invalid-input", "missing_path_parameter", `${name} is required.`)
  );
}

export function requiredIdempotencyKey(context: EvaluationRequestContext): string {
  return (
    context.invocation.idempotencyKey ??
    failure("invalid-input", "missing_idempotency_key", "Idempotency-Key is required.")
  );
}

export function pageOptions(context: EvaluationRequestContext) {
  const { cursor, limit } = context.invocation.query;
  return {
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** The `status` filter; the router already validated it against the route's contract enum. */
export function statusFilter<Status extends string>(context: EvaluationRequestContext) {
  const { status } = context.invocation.query;
  return status === undefined ? {} : { status: status as Status };
}

/** The evaluation queue, or a 503 when this deployment has no queue configured. */
export function requiredQueue(context: EvaluationRequestContext): EvaluationQueue {
  const queue = context.dependencies.queue;
  if (!queue) {
    throw new EvaluationApiProblem(
      503,
      "evaluations_unavailable",
      "Evaluation runs are not available in this deployment.",
    );
  }
  return queue;
}

/** Internal semantic event metadata for an evaluation aggregate mutation. */
export async function evaluationEvent(
  context: EvaluationRequestContext,
  eventType: string,
  payload: Readonly<Record<string, string | number>>,
): Promise<EvaluationPersistenceEvent> {
  return {
    actor: isUlid(context.principalId)
      ? { id: context.principalId, type: "principal" }
      : { type: "principal" },
    eventId: await context.newId(),
    eventType,
    occurredAt: context.timestamp,
    payload: internalSemanticEventPayload(payload),
  };
}
