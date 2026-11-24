import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import {
  ResendSystemPrincipalVerificationRequest,
  RevokeSystemPrincipalSessionsRequest,
  SYSTEM_SECURITY_EVENT_DETAIL_FIELDS,
  type FindSystemPrincipalResponse,
  type ListSystemPrincipalSecurityEventsResponse,
  type SystemPrincipalResponse,
  type SystemPrincipalSessionsRevokedResponse,
  type SystemPrincipalVerificationSentResponse,
} from "@deployments-ai/api-contract/system";
import {
  PrincipalCommand,
  Ulid,
  principalCommandReply,
  type PendingSignUp,
  type PlatformPrincipalDirectory,
  type PlatformPrincipalSecurityEvent,
  type PrincipalOperatorCommand,
  type PrincipalReply,
  type PrincipalSignIn,
} from "@deployments-ai/db";
import { normalizeEmail } from "@deployments-ai/identity";
import { Schema } from "effect";
import type { LambdaInvoker } from "../observability-erasure.ts";
import { PRINCIPAL_STATUS_FUNCTION_ENV } from "./principal-status.ts";
import { SystemOperatorProblem, parseBody } from "./service.ts";

type Encoded<S extends Schema.Top> = S["Encoded"];

const decodeUlid = Schema.decodeUnknownSync(Ulid);
const encodeCommand = Schema.encodeSync(PrincipalCommand);
const decodeRevoke = Schema.decodeUnknownSync(RevokeSystemPrincipalSessionsRequest, {
  onExcessProperty: "error",
});
const decodeResend = Schema.decodeUnknownSync(ResendSystemPrincipalVerificationRequest, {
  onExcessProperty: "error",
});
const DETAIL_FIELDS: ReadonlySet<string> = new Set(SYSTEM_SECURITY_EVENT_DETAIL_FIELDS);

/** Platform identity's principal function, which alone reads and writes the identity table. */
export interface IdentityPrincipalCommands {
  readonly send: <Kind extends "described" | "sessions-ended" | "sign-up" | "verification">(
    command: PrincipalOperatorCommand,
    reply: Kind,
  ) => Promise<PrincipalReply<Kind>>;
}

export function identityPrincipalCommands(
  environment: NodeJS.ProcessEnv,
  client: LambdaInvoker = new LambdaClient({}),
): IdentityPrincipalCommands | undefined {
  const functionName = environment[PRINCIPAL_STATUS_FUNCTION_ENV]?.trim();
  if (!functionName) return undefined;
  return {
    async send(command, reply) {
      const response = await client.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: "RequestResponse",
          Payload: Buffer.from(JSON.stringify(encodeCommand(command))),
        }),
      );
      if (response.FunctionError || !response.Payload) {
        throw new Error(`Principal function failed: ${response.FunctionError ?? "empty response"}`);
      }
      return principalCommandReply(
        JSON.parse(Buffer.from(response.Payload).toString("utf8")),
        reply,
      );
    },
  };
}

export interface SystemPrincipals {
  readonly find: (
    email: string | undefined,
  ) => Promise<Encoded<typeof FindSystemPrincipalResponse>>;
  readonly get: (principalId: string) => Promise<Encoded<typeof SystemPrincipalResponse>>;
  readonly resendVerification: (input: {
    readonly body: unknown;
    readonly operatorId: string;
    readonly principalId: string;
  }) => Promise<Encoded<typeof SystemPrincipalVerificationSentResponse>>;
  readonly revokeSessions: (input: {
    readonly body: unknown;
    readonly operatorId: string;
    readonly principalId: string;
  }) => Promise<Encoded<typeof SystemPrincipalSessionsRevokedResponse>>;
  readonly securityEvents: (input: {
    readonly cursor?: string | undefined;
    readonly limit?: number | undefined;
    readonly principalId: string;
  }) => Promise<Encoded<typeof ListSystemPrincipalSecurityEventsResponse>>;
}

function unmanaged(): never {
  throw new SystemOperatorProblem(
    409,
    "principal_status_unmanaged",
    "This install does not run platform identity, so its identity provider manages people's sign-in.",
  );
}

function emailQuery(email: string | undefined) {
  if (email === undefined) {
    throw new SystemOperatorProblem(400, "invalid_email", "email is required.");
  }
  try {
    return normalizeEmail(email);
  } catch {
    throw new SystemOperatorProblem(400, "invalid_email", "email must be an email address.");
  }
}

function personNotFound(): never {
  throw new SystemOperatorProblem(404, "principal_not_found", "No person has that principal ID.");
}

function signInView(signIn: PrincipalSignIn | null) {
  return signIn
    ? {
        emailVerifiedAt: signIn.emailVerifiedAt ?? null,
        mfa: signIn.mfa,
        sessions: {
          browser: signIn.sessions.browser,
          capped: signIn.sessions.capped,
          refreshTokenFamilies: signIn.sessions.refreshFamilies,
        },
      }
    : null;
}

function signUpView(signUp: PendingSignUp) {
  return {
    createdAt: signUp.createdAt,
    email: signUp.email,
    expiresAt: signUp.expiresAt,
    principalId: signUp.principalId,
    verificationEmailSentAt: signUp.verificationEmailSentAt,
  };
}

/** Only scalar payload fields on the allowlist are shown; the rest are named, never valued. */
export function securityEventView(event: PlatformPrincipalSecurityEvent) {
  const details: Record<string, boolean | number | string> = {};
  const withheldFields: string[] = [];
  for (const [field, value] of Object.entries(event.payload)) {
    if (
      DETAIL_FIELDS.has(field) &&
      (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    ) {
      details[field] = value;
    } else {
      withheldFields.push(field);
    }
  }
  return {
    actor: event.actor ? { id: event.actor.id ?? null, type: event.actor.type } : null,
    details,
    eventType: event.eventType,
    id: event.eventId,
    occurredAt: event.occurredAt,
    withheldFields: withheldFields.toSorted(),
  };
}

/**
 * Person reads and sign-in actions for platform administrators. The control and events tables
 * are read here; everything in the identity table goes through platform identity's function.
 */
export function makeSystemPrincipals(dependencies: {
  readonly directory: PlatformPrincipalDirectory;
  readonly identity: IdentityPrincipalCommands | undefined;
}): SystemPrincipals {
  const { directory } = dependencies;
  const identity = () => dependencies.identity ?? unmanaged();

  return {
    async find(rawEmail) {
      const email = emailQuery(rawEmail);
      const person = await directory.findByEmail(email);
      if (person) {
        return {
          kind: "person",
          person: {
            createdAt: person.createdAt,
            displayName: person.displayName ?? null,
            id: person.id,
            kind: person.kind,
            platformRole: person.platformRole ?? null,
            primaryEmail: person.primaryEmail ?? null,
            status: person.status,
            updatedAt: person.updatedAt,
          },
        };
      }
      const { signUp } = dependencies.identity
        ? await dependencies.identity.send({ email, kind: "find-sign-up" }, "sign-up")
        : { signUp: null };
      if (!signUp) {
        throw new SystemOperatorProblem(
          404,
          "principal_not_found",
          "No person or pending sign-up has that email.",
        );
      }
      return { kind: "sign-up", signUp: signUpView(signUp) };
    },

    async get(rawPrincipalId) {
      const principalId = decodeUlid(rawPrincipalId);
      const found = await directory.get(principalId);
      if (!found) personNotFound();
      const { principal } = found;
      const { signIn } = dependencies.identity
        ? await dependencies.identity.send({ kind: "describe", principalId }, "described")
        : { signIn: null };
      return {
        createdAt: principal.createdAt,
        displayName: principal.displayName ?? null,
        id: principal.id,
        kind: principal.kind,
        organizations: {
          capped: found.membershipsCapped,
          items: found.memberships.map((membership) => ({
            joinedAt: membership.joinedAt ?? null,
            name: membership.organization?.name ?? null,
            organizationId: membership.organizationId,
            organizationStatus: membership.organization?.status ?? null,
            role: membership.role,
            slug: membership.organization?.slug ?? null,
            status: membership.status,
          })),
        },
        platformRole: principal.platformRole ?? null,
        primaryEmail: principal.primaryEmail ?? null,
        signIn: signInView(signIn),
        status: principal.status,
        updatedAt: principal.updatedAt,
      };
    },

    async securityEvents({ cursor, limit, principalId }) {
      const page = await directory.securityEvents(decodeUlid(principalId), { cursor, limit });
      return { items: page.items.map(securityEventView), nextCursor: page.nextCursor ?? null };
    },

    async revokeSessions({ body, operatorId, principalId }) {
      const { reason } = parseBody(decodeRevoke, body);
      const { outcome } = await identity().send(
        {
          actorPrincipalId: decodeUlid(operatorId),
          kind: "revoke-sessions",
          principalId: decodeUlid(principalId),
          reason: reason.trim(),
        },
        "sessions-ended",
      );
      return outcome;
    },

    async resendVerification({ body, operatorId, principalId }) {
      const { email: rawEmail, reason } = parseBody(decodeResend, body);
      const { outcome } = await identity().send(
        {
          actorPrincipalId: decodeUlid(operatorId),
          ...(rawEmail === undefined ? {} : { email: emailQuery(rawEmail) }),
          kind: "reissue-verification",
          principalId: decodeUlid(principalId),
          reason: reason.trim(),
        },
        "verification",
      );
      switch (outcome.outcome) {
        case "sent":
          return { email: outcome.email, principalId: outcome.principalId, sentAt: outcome.sentAt };
        case "principal-exists":
          throw outcome.emailVerified
            ? new SystemOperatorProblem(
                409,
                "email_already_verified",
                "The person already verified this email.",
              )
            : new SystemOperatorProblem(
                409,
                "verification_not_pending",
                "The person's account exists without a verified email, and platform identity verifies an email only while signing up.",
              );
        case "rate-limited":
          throw new SystemOperatorProblem(
            429,
            "verification_email_rate_limited",
            outcome.reason === "recently-sent"
              ? "A verification email went out in the last minute. Wait before sending another."
              : "This email has had three verification emails in the current hour, the self-service limit.",
          );
        case "registration-closed":
          throw new SystemOperatorProblem(
            409,
            "registration_disabled",
            "Self-service registration is off, so a verification link could not be used.",
          );
        case "sign-up-not-found":
          throw new SystemOperatorProblem(
            404,
            "sign_up_not_found",
            "No person or unexpired sign-up has that principal ID. For a sign-up, send the email it waits on.",
          );
      }
    },
  };
}
