import {
  PersistenceError,
  accountSessionsEnded,
  anonymizedPrincipal,
  emailChangeRecord,
  isDatabaseWriteConflict,
  makeIdentitySecurityEventRecord,
  passwordVoided,
  pendingEmailDeliveryRecord,
  principalEmailReplacement,
  type AccountStandingRepository,
  type EmailChangeData,
  type IdentityRecord,
  type IdentityRepository,
  type ProtectedEnvelope,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import {
  IdentityError,
  constantTimeTextEqual,
  emailClaimValue,
  normalizeEmail,
  randomToken,
  sha256,
  type RandomSource,
} from "@deployments-ai/identity";
import {
  deletionBlockedMessage,
  emailChangeAvailability,
  planAccountDeletion,
  type AccountDeletionPlan,
  type AccountFacts,
  type EmailChangeAvailability,
} from "./account-deletion.ts";
import { deliveryShard } from "./email-delivery-shard.ts";
import { emailChangeTransitions, viewEmailChange } from "./email-change.ts";
import type { MfaApplication } from "./mfa-application.ts";
import { plusSeconds } from "./time-arithmetic.ts";

const WRITE_ATTEMPTS = 5;
const NOTICE_LIFETIME_SECONDS = 24 * 60 * 60;

type ChangeRecord = IdentityRecord<"principal-email-change">;
type Purpose =
  | "account-deleted"
  | "email-change-reported"
  | "email-change-verify"
  | "email-changed";

/** What the account page shows about the person's email and the account's deletability. */
export interface AccountProfile {
  readonly deletion: AccountDeletionPlan;
  readonly email: string;
  readonly emailChange: EmailChangeAvailability;
  readonly pendingEmail?: { readonly email: string; readonly expiresAt: string };
}

export interface AccountLifecycleDependencies {
  readonly encryptEmailPayload: (
    value: unknown,
    context: Readonly<Record<string, string>>,
  ) => Promise<ProtectedEnvelope>;
  readonly generateId: () => Ulid;
  readonly now: () => Date;
  readonly random: RandomSource;
  readonly repository: IdentityRepository;
  readonly standing: AccountStandingRepository;
}

function exposed(code: "access_denied" | "invalid_request", message: string, status?: number) {
  return new IdentityError(code, message, {
    exposeDescription: true,
    ...(status ? { status } : {}),
  });
}

const linkInvalid = () =>
  new IdentityError("invalid_grant", "This link is invalid or has expired.", {
    exposeDescription: true,
  });

/** Email links carry `<principalId>.<secret>`, so the page needs no session to find the change. */
function linkToken(principalId: Ulid, secret: string) {
  return `${principalId}.${secret}`;
}

function parseLinkToken(token: string) {
  const separator = token.indexOf(".");
  const principalId = token.slice(0, separator);
  const secret = token.slice(separator + 1);
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(principalId) || !secret) throw linkInvalid();
  return { principalId: principalId as Ulid, secret };
}

function changeOperation(previous: ChangeRecord | undefined, next: EmailChangeData) {
  const record = emailChangeRecord(next);
  return previous
    ? ({ kind: "put", previousRecord: previous, record } as const)
    : ({ kind: "put", record } as const);
}

export function makeAccountLifecycleApplication(
  dependencies: AccountLifecycleDependencies,
  mfa: Pick<MfaApplication, "reauthenticate">,
) {
  const { repository, standing } = dependencies;

  async function delivery(input: {
    readonly at: Date;
    readonly expiresAt?: string;
    readonly principalId: Ulid;
    readonly purpose: Purpose;
    readonly recipient: string;
    readonly token?: string;
  }): Promise<TransactionOperation> {
    const deliveryId = dependencies.generateId();
    const protectedPayload = await dependencies.encryptEmailPayload(
      {
        ...(input.token ? { actionToken: input.token } : {}),
        recipient: input.recipient,
        schemaVersion: 1,
      },
      { deliveryId, purpose: input.purpose },
    );
    return {
      kind: "put",
      record: pendingEmailDeliveryRecord({
        createdAt: input.at.toISOString(),
        dispatchShard: deliveryShard(deliveryId),
        expiresAt: input.expiresAt ?? plusSeconds(input.at, NOTICE_LIFETIME_SECONDS),
        id: deliveryId,
        principalId: input.principalId,
        protectedPayload,
        purpose: input.purpose,
      }),
    };
  }

  function changeEvent(next: EmailChangeData, eventType: string): TransactionOperation {
    return {
      kind: "put",
      record: makeIdentitySecurityEventRecord({
        aggregateId: next.id,
        aggregateType: "principal-email-change",
        aggregateVersion: next.version,
        eventId: dependencies.generateId(),
        eventType,
        occurredAt: next.updatedAt,
        principalId: next.principalId,
      }),
    };
  }

  async function commit(operations: readonly TransactionOperation[], conflict: string) {
    try {
      await repository.transact(operations);
    } catch (error) {
      if (!isDatabaseWriteConflict(error)) throw error;
      throw exposed("invalid_request", conflict, 409);
    }
  }

  async function facts(principalId: Ulid): Promise<AccountFacts & { readonly email: string }> {
    const at = dependencies.now();
    const [material, change, ties] = await Promise.all([
      repository.loadLoginMaterial(principalId),
      repository.emailChangeForPrincipal(principalId),
      standing.ties(principalId),
    ]);
    const { credential, principal, securityState } = material;
    if (!principal?.data.primaryEmail || !securityState) {
      throw exposed("access_denied", "Your account is no longer active.", 401);
    }
    return {
      at,
      change: viewEmailChange(change?.data, at, securityState.data.credentialVersion),
      email: principal.data.primaryEmail,
      hasPassword: credential?.data.status === "active",
      platformAdministrator: principal.data.platformRole === "administrator",
      ties,
    };
  }

  async function profile(principalId: Ulid): Promise<AccountProfile> {
    const known = await facts(principalId);
    return {
      deletion: planAccountDeletion(known),
      email: known.email,
      emailChange: emailChangeAvailability(known),
      ...(known.change.kind === "pending"
        ? {
            pendingEmail: {
              email: known.change.change.newEmail,
              expiresAt: known.change.change.expiresAt,
            },
          }
        : {}),
    };
  }

  /**
   * Starts a change after the person proves themselves again. Only the new address hears about it
   * now, with a link that applies it; an older pending request is replaced, so its link stops
   * working. Whether another account holds the address is left to confirmation, which takes the
   * claim, so this answer never tells the requester which addresses are registered.
   */
  async function requestEmailChange(input: {
    readonly code?: string;
    readonly newEmail: string;
    readonly password: string;
    readonly principalId: Ulid;
  }) {
    const newEmail = normalizeEmail(input.newEmail);
    const known = await facts(input.principalId);
    const availability = emailChangeAvailability(known);
    if (availability.kind === "managed") {
      throw exposed(
        "invalid_request",
        `${availability.organizationName} manages your email address. Ask its administrators to change it.`,
        409,
      );
    }
    if (availability.kind === "held") {
      throw exposed(
        "invalid_request",
        availability.reason === "changed"
          ? "Your email changed recently. You can change it again once the notice sent to your previous address expires."
          : "An email change on your account was reported recently. You can change it again in seven days.",
        409,
      );
    }
    if (newEmail === known.email) {
      throw exposed("invalid_request", "That is already your email address.");
    }
    const { material, operations } = await mfa.reauthenticate(input);
    const at = dependencies.now();
    const previous = await repository.emailChangeForPrincipal(input.principalId);
    const token = randomToken(dependencies.random);
    const next = emailChangeTransitions.request({
      at,
      credentialVersion: material.securityState.data.credentialVersion,
      newEmail,
      previous: previous?.data,
      principalId: input.principalId,
      tokenHash: sha256(token),
    });
    await commit(
      [
        ...repository.loginMaterialVersionChecks(material.principal, material.securityState),
        ...operations,
        changeOperation(previous, next),
        changeEvent(next, "identity.email-change-requested"),
        await delivery({
          at,
          expiresAt: next.expiresAt,
          principalId: input.principalId,
          purpose: "email-change-verify",
          recipient: newEmail,
          token: linkToken(input.principalId, token),
        }),
      ],
      "Your account changed while this was saving. Try again.",
    );
    return { email: newEmail, expiresAt: next.expiresAt };
  }

  async function cancelEmailChange(principalId: Ulid) {
    const previous = await repository.emailChangeForPrincipal(principalId);
    if (previous?.data.state !== "pending") return;
    const next = emailChangeTransitions.cancel(previous.data, dependencies.now());
    await commit(
      [changeOperation(previous, next), changeEvent(next, "identity.email-change-cancelled")],
      "Your email change moved on while this was saving. Reload and try again.",
    );
  }

  /**
   * Applies a change from the link sent to the new address. In one transaction the principal
   * takes the new address's claim and releases the old one, every session ends, and the old
   * address is sent a notice with a link to report the change.
   */
  async function confirmEmailChange(input: { readonly token: string }) {
    const { principalId, secret } = parseLinkToken(input.token);
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const at = dependencies.now();
      const [previous, material, fence] = await Promise.all([
        repository.emailChangeForPrincipal(principalId),
        repository.loadLoginMaterial(principalId),
        repository.bffFenceForPrincipal(principalId),
      ]);
      const { principal, securityState } = material;
      if (
        previous?.data.state !== "pending" ||
        !constantTimeTextEqual(previous.data.tokenHash, sha256(secret)) ||
        viewEmailChange(previous.data, at, securityState?.data.credentialVersion ?? -1).kind !==
          "pending" ||
        principal?.data.status !== "active" ||
        !principal.data.primaryEmail ||
        !securityState ||
        !fence
      ) {
        throw linkInvalid();
      }
      const reportToken = randomToken(dependencies.random);
      const next = emailChangeTransitions.apply(previous.data, {
        at,
        previousEmail: principal.data.primaryEmail,
        reportTokenHash: sha256(reportToken),
      });
      try {
        await repository.transact([
          ...principalEmailReplacement({
            at: next.updatedAt,
            eventId: dependencies.generateId(),
            fence,
            primaryEmail: next.newEmail,
            principal,
            security: securityState,
          }),
          changeOperation(previous, next),
          changeEvent(next, "identity.email-change-applied"),
          await delivery({
            at,
            expiresAt: next.reportExpiresAt,
            principalId,
            purpose: "email-changed",
            recipient: next.previousEmail,
            token: linkToken(principalId, reportToken),
          }),
        ]);
        return { email: next.newEmail };
      } catch (error) {
        if (!isDatabaseWriteConflict(error)) throw error;
        if (await repository.principalForEmailHash(emailClaimValue(previous.data.newEmail))) {
          throw exposed("invalid_request", "Another account took that email address first.", 409);
        }
      }
    }
    throw new IdentityError(
      "temporarily_unavailable",
      "The email change could not be applied because your account kept changing.",
      { status: 503 },
    );
  }

  /**
   * The old address says it did not make the change. The address comes back when it is still free,
   * and every session ends either way, so whoever changed it is signed out. Whoever made the change
   * knew the password, so the password stops working and the credential version advances, which
   * voids reset links already sent to the reported address; a reset now reaches only the address
   * the account uses after the report. The reported address is told, and new changes are held.
   */
  async function reportEmailChange(input: { readonly token: string }) {
    const { principalId, secret } = parseLinkToken(input.token);
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      const at = dependencies.now();
      const [previous, material, fence] = await Promise.all([
        repository.emailChangeForPrincipal(principalId),
        repository.loadLoginMaterial(principalId),
        repository.bffFenceForPrincipal(principalId),
      ]);
      const { credential, principal, securityState } = material;
      if (
        previous?.data.state !== "applied" ||
        !constantTimeTextEqual(previous.data.reportTokenHash, sha256(secret)) ||
        Date.parse(previous.data.reportExpiresAt) <= at.getTime() ||
        principal?.data.status !== "active" ||
        !securityState ||
        !fence
      ) {
        throw linkInvalid();
      }
      const restorable =
        principal.data.primaryEmail === previous.data.newEmail &&
        !(await repository.principalForEmailHash(emailClaimValue(previous.data.previousEmail)));
      const next = emailChangeTransitions.report(previous.data, at, restorable);
      const signInState = {
        at: next.updatedAt,
        eventId: dependencies.generateId(),
        fence,
        principal,
        security: securityState,
        voidCredentials: true,
      };
      try {
        await repository.transact([
          ...(restorable
            ? principalEmailReplacement({
                ...signInState,
                primaryEmail: previous.data.previousEmail,
              })
            : accountSessionsEnded({ ...signInState, eventType: "identity.sessions-invalidated" })),
          ...(credential ? [passwordVoided(credential, next.updatedAt)] : []),
          changeOperation(previous, next),
          changeEvent(next, "identity.email-change-reported"),
          await delivery({
            at,
            principalId,
            purpose: "email-change-reported",
            recipient: previous.data.newEmail,
          }),
        ]);
        return { emailRestored: restorable };
      } catch (error) {
        if (!isDatabaseWriteConflict(error)) throw error;
      }
    }
    throw new IdentityError(
      "temporarily_unavailable",
      "The report could not be saved because the account kept changing.",
      { status: 503 },
    );
  }

  /**
   * Deletes the account at once. The person proves themselves again, and the code they used is
   * spent in its own write before anything else, so a deletion that fails later cannot leave it
   * reusable. Each attempt then plans again from fresh memberships, so one added since the account
   * page loaded is left too, and removes them one organization at a time with its own events.
   * Last, one transaction archives the principal without personal data, releases the email claim,
   * deletes its federated identity links, ends every session, refresh token and device grant,
   * deletes the password and second factor, and sends the confirmation. Organizations already
   * left stay left when a later one refuses: leaving is what the person asked for either way.
   */
  async function deleteAccount(input: {
    readonly code?: string;
    readonly password: string;
    readonly principalId: Ulid;
  }) {
    const known = await facts(input.principalId);
    const plan = planAccountDeletion(known);
    if (plan.kind === "blocked") {
      throw exposed("invalid_request", deletionBlockedMessage(plan.blockers), 409);
    }
    const proof = await mfa.reauthenticate(input);
    await commit(
      [
        ...repository.loginMaterialVersionChecks(
          proof.material.principal,
          proof.material.securityState,
        ),
        ...proof.operations,
      ],
      "Your account changed while this was saving. Try again.",
    );
    const leaveAll = async () => {
      const current = planAccountDeletion(await facts(input.principalId));
      if (current.kind === "blocked") {
        throw exposed("invalid_request", deletionBlockedMessage(current.blockers), 409);
      }
      for (const organization of current.leaves) {
        try {
          await standing.leave(input.principalId, organization.organizationId as Ulid);
        } catch (error) {
          if (!(error instanceof PersistenceError) || error.code !== "last_owner_required")
            throw error;
          return false;
        }
      }
      return true;
    };
    for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
      if (!(await leaveAll())) continue;
      const at = dependencies.now();
      const [material, fence, factor, change] = await Promise.all([
        repository.loadLoginMaterial(input.principalId),
        repository.bffFenceForPrincipal(input.principalId),
        repository.mfaFactorForPrincipal(input.principalId),
        repository.emailChangeForPrincipal(input.principalId),
      ]);
      const { credential, principal, securityState } = material;
      if (principal?.data.status !== "active" || !principal.data.primaryEmail) return;
      if (!securityState || !fence) throw exposed("access_denied", "Session is invalid.", 401);
      const links = await standing.federatedLinkRemovals(
        input.principalId,
        principal.data.primaryEmail,
      );
      try {
        await repository.transact([
          ...anonymizedPrincipal({
            at: at.toISOString(),
            eventId: dependencies.generateId(),
            fence,
            principal,
            security: securityState,
          }),
          ...(credential ? [{ kind: "delete" as const, record: credential }] : []),
          ...(factor ? [{ kind: "delete" as const, record: factor }] : []),
          ...(change ? [{ kind: "delete" as const, record: change }] : []),
          ...links,
          await delivery({
            at,
            principalId: input.principalId,
            purpose: "account-deleted",
            recipient: principal.data.primaryEmail,
          }),
        ]);
        return;
      } catch (error) {
        if (!isDatabaseWriteConflict(error)) throw error;
      }
    }
    throw new IdentityError(
      "temporarily_unavailable",
      "Your account could not be deleted because it kept changing. Try again.",
      { status: 503 },
    );
  }

  return {
    cancelEmailChange,
    confirmEmailChange,
    deleteAccount,
    profile,
    reportEmailChange,
    requestEmailChange,
  };
}

export type AccountLifecycleApplication = ReturnType<typeof makeAccountLifecycleApplication>;
