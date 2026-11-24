import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import { PersistenceError, PersistenceFailureKind } from "../persistence-types.ts";
import type {
  PrincipalStatusChange,
  PrincipalStatusOutcome,
  PrincipalStatusRepository,
} from "./principal-status.ts";

const PrincipalStatusTarget = Schema.Literals(["active", "disabled"]);

/**
 * What the API sends platform identity's principal status function. The API checks that the actor
 * is a platform administrator; only identity holds the sign-in state the change must fence.
 */
export const PrincipalStatusCommand = Schema.Struct({
  actorPrincipalId: Ulid,
  principalId: Ulid,
  reason: Schema.String,
  status: PrincipalStatusTarget,
});

const PrincipalStatusReply = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("set"),
    outcome: Schema.Struct({
      changed: Schema.Boolean,
      principalId: Ulid,
      status: PrincipalStatusTarget,
      updatedAt: Schema.String,
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    refusal: Schema.Struct({
      code: Schema.String,
      kind: PersistenceFailureKind,
      message: Schema.String,
    }),
  }),
]);
type PrincipalStatusReply = typeof PrincipalStatusReply.Encoded;

const decodeCommand = Schema.decodeUnknownSync(PrincipalStatusCommand, {
  onExcessProperty: "error",
});
const decodeReply = Schema.decodeUnknownSync(PrincipalStatusReply);

/** Identity's side: applies one command and answers refusals as data, not function errors. */
export function makePrincipalStatusCommandHandler(repository: PrincipalStatusRepository) {
  return async (payload: unknown): Promise<PrincipalStatusReply> => {
    const change: PrincipalStatusChange = decodeCommand(payload);
    try {
      return { kind: "set", outcome: await repository.setStatus(change) };
    } catch (cause) {
      if (!(cause instanceof PersistenceError)) throw cause;
      return {
        kind: "refused",
        refusal: { code: cause.code, kind: cause.kind, message: cause.message },
      };
    }
  };
}

/** The API's side: the outcome identity reported, or the refusal it reported as a PersistenceError. */
export function principalStatusOutcomeFromReply(payload: unknown): PrincipalStatusOutcome {
  const reply = decodeReply(payload);
  if (reply.kind === "refused") {
    throw new PersistenceError(reply.refusal.kind, reply.refusal.code, reply.refusal.message);
  }
  return reply.outcome;
}
