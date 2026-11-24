import { Schema } from "effect";
import { PublicId, Timestamp } from "./primitives.ts";

/**
 * A tenant's own opaque identifier for one of its end users. The platform keeps only a keyed
 * pseudonym of it and never returns it.
 */
export const EndUserId = Schema.String.pipe(
  Schema.check(
    Schema.isMinLength(1, { message: "endUserId must not be empty." }),
    Schema.isMaxLength(256, { message: "endUserId must not exceed 256 characters." }),
  ),
);

const Count = Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)));

export const ConversationErasureCounts = Schema.Struct({
  automationsArchived: Count,
  emailMessagesErased: Count,
  emailThreadsErased: Count,
  ingressRecordsDeleted: Count,
  memoriesErased: Count,
  objectsStaged: Count,
  recordsDeleted: Count,
  runsCanceled: Count,
  streamsDeleted: Count,
  threadsErased: Count,
  threadsPlanned: Count,
});

export const ConversationErasurePhase = Schema.Literals([
  "planning",
  "mail",
  "fencing",
  "automations",
  "memory",
  "canonical",
  "ingress",
  "streams",
  "objects",
  "observability",
  "finalizing",
]);

export const ConversationErasure = Schema.Struct({
  completedAt: Schema.optional(Timestamp),
  counts: ConversationErasureCounts,
  createdAt: Timestamp,
  environmentId: PublicId,
  error: Schema.optional(Schema.Struct({ code: Schema.String, message: Schema.String })),
  id: PublicId,
  kind: Schema.Literals(["end-user", "thread"]),
  phase: ConversationErasurePhase,
  status: Schema.Literals(["canceled", "completed", "failed", "pending", "running"]),
  threadId: Schema.optional(PublicId),
  updatedAt: Timestamp,
});
export type ConversationErasure = typeof ConversationErasure.Type;

export const ConversationErasureResponse = Schema.Struct({ erasure: ConversationErasure });
export type ConversationErasureResponse = typeof ConversationErasureResponse.Type;

export const CreateEndUserErasureRequest = Schema.Struct({ endUserId: EndUserId });
export type CreateEndUserErasureRequest = typeof CreateEndUserErasureRequest.Type;

export const CONVERSATION_ERASURE_API_SCHEMAS = {
  ConversationErasureResponse,
  CreateEndUserErasureRequest,
} as const;
