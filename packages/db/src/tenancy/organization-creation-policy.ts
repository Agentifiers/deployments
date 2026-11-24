import { Schema } from "effect";
import type {
  DynamoDatabaseService,
  TransactionOperation,
  TransactionPut,
} from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { Keys, key } from "../keys.ts";
import { PersistenceError, type PersistenceInvocation } from "../persistence-types.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { PrincipalOrganizationCreationsRecord } from "../records/organization-creation.ts";
import { id, type OrganizationMember } from "../tenancy-contracts.ts";
import { isPlatformAdministrator } from "../tenancy-authorization.ts";
import { databaseValue } from "../tenancy-record-mapping.ts";

export interface OrganizationCreationPolicy {
  /** Set where platform identity signs every human in and signs `email_verified` into their tokens. */
  readonly requireVerifiedEmail: boolean;
  /** Organizations one principal may create over its lifetime; `null` is unlimited. */
  readonly quotaPerPrincipal: number | null;
}

export const UNLIMITED_ORGANIZATION_CREATION: OrganizationCreationPolicy = {
  quotaPerPrincipal: null,
  requireVerifiedEmail: false,
};

type OrganizationCreationRefusal =
  | "email_verification_required"
  | "organization_creation_held"
  | "organization_quota_reached";

function refusalMessage(refusal: OrganizationCreationRefusal, quota: number | null) {
  switch (refusal) {
    case "email_verification_required":
      return "Verify your email address before you create an organization.";
    case "organization_creation_held":
      return "An organization you own or administer is on hold, so you cannot create another one until the hold is released.";
    case "organization_quota_reached":
      return `You have reached this installation's limit of ${quota} created organizations per person.`;
  }
}

/**
 * A platform administrator is exempt. Anyone else increments their lifetime count in the create
 * transaction, conditioned on the count they were admitted against.
 */
type Admission =
  | { readonly kind: "exempt" }
  | {
      readonly countedFromVersion: number;
      readonly kind: "counted";
      readonly operation: TransactionPut;
    };

export interface OrganizationCreationFence {
  /**
   * Admits the caller, then runs `write` with the operations the create transaction must carry.
   * A create that loses the count to a concurrent create by the same person is admitted again,
   * so the loser of a race for the last allowed organization is refused with the quota.
   */
  readonly commit: (
    invocation: PersistenceInvocation,
    at: string,
    write: (operations: readonly TransactionOperation[]) => Promise<void>,
  ) => Promise<void>;
}

export function makeOrganizationCreationFence(
  database: DynamoDatabaseService,
  policy: OrganizationCreationPolicy,
): OrganizationCreationFence {
  const creations = async (principalId: Ulid) => {
    const stored = await databaseValue(
      database.getRecord(
        "control",
        { pk: key("PRINCIPAL", principalId), sk: key("PRINCIPAL-ORGANIZATION-CREATIONS") },
        true,
      ),
    );
    return stored?.itemType === "principal-organization-creations" ? stored : undefined;
  };

  const managedOrganizationIds = async (principalId: Ulid) => {
    const managed: Ulid[] = [];
    let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
    do {
      const page = await databaseValue(
        database.queryRecords("control", {
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
          ExpressionAttributeNames: { "#partition": "gsi2pk", "#sort": "gsi2sk" },
          ExpressionAttributeValues: {
            ":partition": key("PRINCIPAL", principalId),
            ":prefix": `${key("ORGANIZATION-MEMBER")}#`,
          },
          IndexName: "gsi2",
          KeyConditionExpression: "#partition = :partition AND begins_with(#sort, :prefix)",
          Limit: 100,
        }),
      );
      for (const record of page.items) {
        const member = record as OrganizationMember;
        if (
          member.itemType === "organization-member" &&
          (member.data.role === "owner" || member.data.role === "admin") &&
          member.data.status === "active"
        ) {
          managed.push(member.data.organizationId);
        }
      }
      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey);
    return managed;
  };

  const managesHeldOrganization = async (principalId: Ulid) => {
    const standings = await Promise.all(
      (await managedOrganizationIds(principalId)).map((organizationId) =>
        databaseValue(
          database.getRecord("control", Keys.control.organizationStanding(organizationId), true),
        ),
      ),
    );
    return standings.some(
      (standing) =>
        standing?.itemType === "organization-standing" && standing.data.suspension !== undefined,
    );
  };

  async function admit(invocation: PersistenceInvocation, at: string): Promise<Admission> {
    if (isPlatformAdministrator(invocation)) return { kind: "exempt" };
    const principalId = id(invocation.identity.principalId);
    const [previous, held] = await Promise.all([
      creations(principalId),
      managesHeldOrganization(principalId),
    ]);
    const created = previous?.data.organizationsCreated ?? 0;
    const refusal: OrganizationCreationRefusal | undefined =
      policy.requireVerifiedEmail && invocation.identity.emailVerified !== true
        ? "email_verification_required"
        : held
          ? "organization_creation_held"
          : policy.quotaPerPrincipal !== null && created >= policy.quotaPerPrincipal
            ? "organization_quota_reached"
            : undefined;
    if (refusal) {
      throw new PersistenceError(
        "forbidden",
        refusal,
        refusalMessage(refusal, policy.quotaPerPrincipal),
      );
    }
    const record = Schema.decodeUnknownSync(PrincipalOrganizationCreationsRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: previous?.data.createdAt ?? at,
          organizationsCreated: created + 1,
          principalId,
          updatedAt: at,
          version: (previous?.data.version ?? 0) + 1,
        },
        itemType: "principal-organization-creations" as const,
      }),
    );
    return {
      countedFromVersion: previous?.data.version ?? 0,
      kind: "counted",
      operation: { kind: "put", ...(previous ? { previousRecord: previous } : {}), record },
    };
  }

  return {
    async commit(invocation, at, write) {
      const admission = await admit(invocation, at);
      if (admission.kind === "exempt") return write([]);
      try {
        await write([admission.operation]);
      } catch (cause) {
        if (!(cause instanceof PersistenceError) || cause.kind !== "conflict") throw cause;
        const readmission = await admit(invocation, at);
        if (
          readmission.kind === "counted" &&
          readmission.countedFromVersion !== admission.countedFromVersion
        ) {
          throw new PersistenceError(
            "conflict",
            "organization_creation_conflict",
            "Another organization you were creating finished first. Retry the request.",
          );
        }
        throw cause;
      }
    },
  };
}
