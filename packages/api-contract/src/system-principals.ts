import { Schema } from "effect";
import { Cursor, PublicId, Timestamp } from "./primitives.ts";

/** How many of a person's memberships `getSystemPrincipal` returns; `capped` says more exist. */
export const SYSTEM_PRINCIPAL_MEMBERSHIP_LIMIT = 100;
/** How many sessions and refresh token families of each kind the count reads. */
export const SYSTEM_PRINCIPAL_SESSION_COUNT_LIMIT = 100;
/**
 * Security event payload fields an operator sees. Every other field is withheld and named in
 * `withheldFields`, so a new event type cannot leak a token, hash, or address before review.
 */
export const SYSTEM_SECURITY_EVENT_DETAIL_FIELDS = [
  "clientId",
  "generation",
  "platformRole",
  "reason",
  "retriedGeneration",
  "status",
] as const;

const Reason = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((input) =>
      input.trim().length > 0 ? undefined : "Expected a non-blank string.",
    ),
    Schema.isMaxLength(500),
  ),
).annotate({ description: "Why the operator acts; recorded in the person's security events." });

export const SystemPrincipalSummary = Schema.Struct({
  createdAt: Timestamp,
  displayName: Schema.NullOr(Schema.String),
  id: PublicId,
  kind: Schema.Literals(["human", "service", "support"]),
  platformRole: Schema.NullOr(Schema.Literal("administrator")),
  primaryEmail: Schema.NullOr(Schema.String),
  status: Schema.Literals(["active", "archived", "disabled"]),
  updatedAt: Timestamp,
});

export const SystemPendingSignUp = Schema.Struct({
  createdAt: Timestamp,
  email: Schema.String,
  expiresAt: Timestamp,
  principalId: PublicId.annotate({
    description: "The principal ID the person gets when they verify the email.",
  }),
  verificationEmailSentAt: Timestamp,
});

export const FindSystemPrincipalResponse = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("person"), person: SystemPrincipalSummary }),
  Schema.Struct({ kind: Schema.Literal("sign-up"), signUp: SystemPendingSignUp }),
]).annotate({
  description:
    "The person holding the email, or the sign-up waiting for that email to be verified.",
});

const MfaState = Schema.Union([
  Schema.Struct({ state: Schema.Literal("none") }),
  Schema.Struct({ since: Timestamp, state: Schema.Literal("pending") }),
  Schema.Struct({
    activatedAt: Timestamp,
    recoveryCodesRemaining: Schema.Number,
    state: Schema.Literal("active"),
  }),
  Schema.Struct({ disabledAt: Timestamp, state: Schema.Literal("disabled") }),
]);

export const SystemPrincipalResponse = Schema.Struct({
  ...SystemPrincipalSummary.fields,
  organizations: Schema.Struct({
    capped: Schema.Boolean,
    items: Schema.Array(
      Schema.Struct({
        joinedAt: Schema.NullOr(Schema.String),
        name: Schema.NullOr(Schema.String),
        organizationId: PublicId,
        organizationStatus: Schema.NullOr(Schema.Literals(["active", "archived", "disabled"])),
        role: Schema.Literals(["admin", "billing", "member", "owner", "viewer"]),
        slug: Schema.NullOr(Schema.String),
        status: Schema.Literals(["active", "invited", "removed"]),
      }),
    ),
  }),
  signIn: Schema.NullOr(
    Schema.Struct({
      emailVerifiedAt: Schema.NullOr(Timestamp),
      mfa: MfaState,
      sessions: Schema.Struct({
        browser: Schema.Number,
        capped: Schema.Boolean,
        refreshTokenFamilies: Schema.Number,
      }),
    }),
  ).annotate({
    description: "null where platform identity holds no sign-in state for the person.",
  }),
});

export const SystemPrincipalSecurityEvent = Schema.Struct({
  actor: Schema.NullOr(Schema.Struct({ id: Schema.NullOr(PublicId), type: Schema.String })),
  details: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
  ),
  eventType: Schema.String,
  id: PublicId,
  occurredAt: Timestamp,
  withheldFields: Schema.Array(Schema.String),
});

export const ListSystemPrincipalSecurityEventsResponse = Schema.Struct({
  items: Schema.Array(SystemPrincipalSecurityEvent),
  nextCursor: Schema.NullOr(Cursor),
});

export const RevokeSystemPrincipalSessionsRequest = Schema.Struct({ reason: Reason });

export const SystemPrincipalSessionsRevokedResponse = Schema.Struct({
  principalId: PublicId,
  sessionsEndedAt: Timestamp.annotate({
    description: "Every session, refresh token, and device grant issued before this ended.",
  }),
});

export const ResendSystemPrincipalVerificationRequest = Schema.Struct({
  email: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "The email a pending sign-up waits on. A sign-up has no principal record yet, so platform identity finds it by email.",
    }),
  ),
  reason: Reason,
});

export const SystemPrincipalVerificationSentResponse = Schema.Struct({
  email: Schema.String,
  principalId: PublicId,
  sentAt: Timestamp,
});

export const SYSTEM_PRINCIPAL_API_SCHEMAS = {
  FindSystemPrincipalResponse,
  ListSystemPrincipalSecurityEventsResponse,
  ResendSystemPrincipalVerificationRequest,
  RevokeSystemPrincipalSessionsRequest,
  SystemPrincipalResponse,
  SystemPrincipalSessionsRevokedResponse,
  SystemPrincipalVerificationSentResponse,
} as const;
