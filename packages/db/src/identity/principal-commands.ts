import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import { PersistenceError, PersistenceFailureKind } from "../persistence-types.ts";
import type { PrincipalSecurityRepository } from "./principal-security.ts";
import type { PrincipalStatusRepository } from "./principal-status.ts";
import {
  makePrincipalStatusCommandHandler,
  PrincipalStatusCommand,
} from "./principal-status-command.ts";

const Timestamp = Schema.String;
const Count = Schema.Number;

export const PrincipalMfaState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("none") }),
  Schema.Struct({ since: Timestamp, state: Schema.Literal("pending") }),
  Schema.Struct({
    activatedAt: Timestamp,
    recoveryCodesRemaining: Count,
    state: Schema.Literal("active"),
  }),
  Schema.Struct({ disabledAt: Timestamp, state: Schema.Literal("disabled") }),
]);
export type PrincipalMfaState = typeof PrincipalMfaState.Type;

/** What platform identity holds about a person's sign-in; never a secret or a token hash. */
export const PrincipalSignIn = Schema.Struct({
  emailVerifiedAt: Schema.optionalKey(Timestamp),
  mfa: PrincipalMfaState,
  /** Usable browser sessions and refresh token families in the current session epoch. */
  sessions: Schema.Struct({ browser: Count, capped: Schema.Boolean, refreshFamilies: Count }),
});
export type PrincipalSignIn = typeof PrincipalSignIn.Type;

/** A sign-up whose email is not verified yet. `principalId` is the ID verification will create. */
export const PendingSignUp = Schema.Struct({
  createdAt: Timestamp,
  email: Schema.String,
  expiresAt: Timestamp,
  principalId: Ulid,
  verificationEmailSentAt: Timestamp,
});
export type PendingSignUp = typeof PendingSignUp.Type;

export const PrincipalSessionsEnded = Schema.Struct({
  principalId: Ulid,
  sessionsEndedAt: Timestamp,
});
export type PrincipalSessionsEnded = typeof PrincipalSessionsEnded.Type;

/** How an operator's request for a fresh verification email ended. Only `sent` wrote anything. */
export const VerificationReissue = Schema.Union([
  Schema.Struct({
    email: Schema.String,
    outcome: Schema.Literal("sent"),
    principalId: Ulid,
    sentAt: Timestamp,
  }),
  Schema.Struct({
    outcome: Schema.Literal("rate-limited"),
    reason: Schema.Literals(["hourly-limit", "recently-sent"]),
  }),
  /** A principal already holds the ID: `emailVerified` says whether identity proved its mailbox. */
  Schema.Struct({ emailVerified: Schema.Boolean, outcome: Schema.Literal("principal-exists") }),
  Schema.Struct({ outcome: Schema.Literal("registration-closed") }),
  Schema.Struct({ outcome: Schema.Literal("sign-up-not-found") }),
]);
export type VerificationReissue = typeof VerificationReissue.Type;

const Reason = Schema.String;

const PrincipalOperatorCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("describe"), principalId: Ulid }),
  Schema.Struct({ email: Schema.String, kind: Schema.Literal("find-sign-up") }),
  Schema.Struct({
    actorPrincipalId: Ulid,
    kind: Schema.Literal("revoke-sessions"),
    principalId: Ulid,
    reason: Reason,
  }),
  Schema.Struct({
    actorPrincipalId: Ulid,
    /** The email a sign-up waits on; a sign-up has no principal record to find it by. */
    email: Schema.optionalKey(Schema.String),
    kind: Schema.Literal("reissue-verification"),
    principalId: Ulid,
    reason: Reason,
  }),
]);

/**
 * Everything the API asks platform identity's principal function to do. A status change keeps its
 * original shape, without `kind`; every later command names its `kind`.
 */
export const PrincipalCommand = Schema.Union([PrincipalStatusCommand, PrincipalOperatorCommand]);
export type PrincipalOperatorCommand = typeof PrincipalOperatorCommand.Type;
export type VerificationReissueCommand = Extract<
  PrincipalOperatorCommand,
  { readonly kind: "reissue-verification" }
>;

const PrincipalCommandReply = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("described"), signIn: Schema.NullOr(PrincipalSignIn) }),
  Schema.Struct({ kind: Schema.Literal("sign-up"), signUp: Schema.NullOr(PendingSignUp) }),
  Schema.Struct({ kind: Schema.Literal("sessions-ended"), outcome: PrincipalSessionsEnded }),
  Schema.Struct({ kind: Schema.Literal("verification"), outcome: VerificationReissue }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    refusal: Schema.Struct({
      code: Schema.String,
      kind: PersistenceFailureKind,
      message: Schema.String,
    }),
  }),
]);
type PrincipalCommandReply = typeof PrincipalCommandReply.Encoded;
type ReplyKind = Exclude<PrincipalCommandReply["kind"], "refused">;
export type PrincipalReply<Kind extends ReplyKind> = Extract<
  typeof PrincipalCommandReply.Type,
  { readonly kind: Kind }
>;

const decodeCommand = Schema.decodeUnknownSync(PrincipalCommand, { onExcessProperty: "error" });
const decodeReply = Schema.decodeUnknownSync(PrincipalCommandReply);

export interface PrincipalCommandDependencies {
  readonly reissueVerification: (
    command: VerificationReissueCommand,
  ) => Promise<VerificationReissue>;
  readonly security: PrincipalSecurityRepository;
  readonly statuses: PrincipalStatusRepository;
}

/** Identity's side: applies one command and answers refusals as data, not function errors. */
export function makePrincipalCommandHandler(dependencies: PrincipalCommandDependencies) {
  const status = makePrincipalStatusCommandHandler(dependencies.statuses);
  async function apply(command: PrincipalOperatorCommand): Promise<PrincipalCommandReply> {
    switch (command.kind) {
      case "describe":
        return {
          kind: "described",
          signIn: (await dependencies.security.describe(command.principalId)) ?? null,
        };
      case "find-sign-up":
        return {
          kind: "sign-up",
          signUp: (await dependencies.security.pendingSignUp(command.email)) ?? null,
        };
      case "revoke-sessions":
        return {
          kind: "sessions-ended",
          outcome: await dependencies.security.revokeSessions(command),
        };
      case "reissue-verification":
        return { kind: "verification", outcome: await dependencies.reissueVerification(command) };
    }
  }
  return async (payload: unknown) => {
    const command = decodeCommand(payload);
    if (!("kind" in command)) return status(payload);
    try {
      return await apply(command);
    } catch (cause) {
      if (!(cause instanceof PersistenceError)) throw cause;
      return {
        kind: "refused" as const,
        refusal: { code: cause.code, kind: cause.kind, message: cause.message },
      };
    }
  };
}

/** The API's side: the reply of the expected kind, or the refusal as a PersistenceError. */
export function principalCommandReply<Kind extends ReplyKind>(
  payload: unknown,
  kind: Kind,
): PrincipalReply<Kind> {
  const reply = decodeReply(payload);
  if (reply.kind === "refused") {
    throw new PersistenceError(reply.refusal.kind, reply.refusal.code, reply.refusal.message);
  }
  if (reply.kind !== kind) {
    throw new Error(`The principal function answered ${reply.kind}, not ${kind}.`);
  }
  return reply as PrincipalReply<Kind>;
}
