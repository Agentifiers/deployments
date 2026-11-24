import { organizationAuditOperationForEvent } from "../audit/organization-audit-log.ts";
import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import { makeIdGenerator, type Ulid } from "../ids.ts";
import { normalizedEmailDomain } from "../identity-federation/linking.ts";
import { deleteWithClaims } from "../identity-federation/operations.ts";
import { makeFederationReads } from "../identity-federation/reads.ts";
import { key } from "../keys.ts";
import { memberRemoval } from "../organization-membership-changes.ts";
import { PersistenceError } from "../persistence-types.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import type { OrganizationMember, OrganizationRole } from "../tenancy-contracts.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";

const WRITE_ATTEMPTS = 5;

/** Who manages a person's identity in an organization, and so owns their email address. */
export type AccountManager = "directory" | "identity-provider";

/** One organization a person belongs to, as account self-service needs to see it. */
export interface OrganizationTie {
  /** Set when that organization's identity provider or directory manages the person. */
  readonly managedBy?: AccountManager;
  readonly organizationId: Ulid;
  readonly organizationName: string;
  readonly role: OrganizationRole;
  /** The person is that organization's only active owner, so it cannot lose them. */
  readonly soleOwner: boolean;
}

export interface AccountStandingRepository {
  /**
   * The organizations where the person is an active or invited member. Each membership row is read
   * consistently, but which organizations to read comes from the principal's membership index,
   * which DynamoDB serves only eventually consistent, so a membership added moments ago can be
   * missing.
   */
  readonly ties: (principalId: Ulid) => Promise<readonly OrganizationTie[]>;
  /**
   * Deletes of every federated identity link the person holds, with the links' uniqueness
   * claims, to commit with the account's deletion. A link is looked up in every organization the
   * person has a membership row in, in any status, and in the organization that verified their
   * email's domain: the organizations where an account with a password can have been linked.
   */
  readonly federatedLinkRemovals: (
    principalId: Ulid,
    email: string,
  ) => Promise<readonly TransactionOperation[]>;
  /**
   * Removes the person's own membership with its organization events and audit entry. A repeat
   * changes nothing; the sole active owner is refused with `last_owner_required`.
   */
  readonly leave: (principalId: Ulid, organizationId: Ulid) => Promise<void>;
}

function isMember(record: { readonly itemType: string }): record is OrganizationMember {
  return record.itemType === "organization-member";
}

export function makeAccountStandingRepository(dependencies: {
  readonly database: DynamoDatabaseService;
  readonly generateId?: () => Ulid;
  readonly now?: () => Date;
}): AccountStandingRepository {
  const { database } = dependencies;
  const ids = makeIdGenerator();
  const generateId = dependencies.generateId ?? (() => ids.generate());
  const now = dependencies.now ?? (() => new Date());
  const reads = makeFederationReads(database);

  async function membershipRows(principalId: Ulid) {
    const found: OrganizationMember[] = [];
    let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
    do {
      const page = await database.queryRecords("control", {
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        ExpressionAttributeNames: { "#partition": "gsi2pk", "#sort": "gsi2sk" },
        ExpressionAttributeValues: {
          ":partition": key("PRINCIPAL", principalId),
          ":prefix": `${key("ORGANIZATION-MEMBER")}#`,
        },
        IndexName: "gsi2",
        KeyConditionExpression: "#partition = :partition AND begins_with(#sort, :prefix)",
        Limit: 100,
      });
      found.push(...page.items.filter(isMember));
      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey);
    return found.filter((member) => member.data.principalId === principalId);
  }

  async function federatedLinkRemovals(principalId: Ulid, email: string) {
    const domain = normalizedEmailDomain(email);
    const [rows, domainOwner] = await Promise.all([
      membershipRows(principalId),
      domain ? reads.verifiedDomainOwner(domain) : undefined,
    ]);
    const organizationIds = new Set([
      ...rows.map((member) => member.data.organizationId),
      ...(domainOwner ? [domainOwner.data.organizationId] : []),
    ]);
    const links = await Promise.all(
      [...organizationIds].map((organizationId) =>
        reads.organizationLink(organizationId, principalId),
      ),
    );
    return links.flatMap((link) => (link ? deleteWithClaims(link) : []));
  }

  async function activeOwners(organizationId: Ulid) {
    let count = 0;
    let exclusiveStartKey: Readonly<Record<string, unknown>> | undefined;
    do {
      const page = await database.queryRecords("control", {
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        ConsistentRead: true,
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": key("ORG", organizationId),
          ":prefix": `${key("ORGANIZATION-MEMBER")}#`,
        },
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
        Limit: 100,
      });
      count += page.items.filter(
        (record) =>
          isMember(record) && record.data.status === "active" && record.data.role === "owner",
      ).length;
      exclusiveStartKey = page.lastEvaluatedKey;
    } while (exclusiveStartKey);
    return count;
  }

  async function managedBy(organizationId: Ulid, principalId: Ulid) {
    const [link, directoryUser] = await Promise.all([
      reads.organizationLink(organizationId, principalId),
      database.getRecord(
        "control",
        { pk: key("ORG", organizationId), sk: key("ORGANIZATION-DIRECTORY-USER", principalId) },
        true,
      ),
    ]);
    if (directoryUser?.itemType === "organization-directory-user") return "directory" as const;
    return link ? ("identity-provider" as const) : undefined;
  }

  /** The index only finds the organization; the membership row itself is read consistently. */
  async function tie(indexed: OrganizationMember): Promise<OrganizationTie | undefined> {
    const { organizationId, principalId } = indexed.data;
    const [organization, manager, member] = await Promise.all([
      reads.organization(organizationId),
      managedBy(organizationId, principalId),
      reads.member(organizationId, principalId),
    ]);
    if (!organization || !member || member.data.status === "removed") return undefined;
    const { role, status } = member.data;
    const owners = status === "active" && role === "owner" ? await activeOwners(organizationId) : 0;
    return {
      ...(manager ? { managedBy: manager } : {}),
      organizationId,
      organizationName: organization.data.name,
      role,
      soleOwner: status === "active" && role === "owner" && owners <= 1,
    };
  }

  async function leaveOnce(principalId: Ulid, organizationId: Ulid) {
    const [previous, organization] = await Promise.all([
      reads.member(organizationId, principalId),
      reads.organization(organizationId),
    ]);
    if (!previous || previous.data.status === "removed" || !organization) return;
    if (
      previous.data.status === "active" &&
      previous.data.role === "owner" &&
      (await activeOwners(organizationId)) <= 1
    ) {
      throw new PersistenceError(
        "conflict",
        "last_owner_required",
        "The organization must retain at least one active owner.",
      );
    }
    const at = now().toISOString();
    const change = memberRemoval({
      at,
      organization,
      previous,
      source: { actorPrincipalId: principalId, kind: "member-api" },
    });
    const events = change.events.map((event) =>
      makeSemanticEventRecord({
        ...event,
        actor: { id: principalId, type: "principal" },
        eventId: generateId(),
        occurredAt: at,
      }),
    );
    const [primary] = events;
    await transactWithSemanticEvents(
      database,
      [
        ...change.operations,
        ...(primary
          ? [organizationAuditOperationForEvent(primary, { id: principalId, type: "principal" })]
          : []),
      ],
      events,
    );
  }

  return {
    federatedLinkRemovals,
    ties: async (principalId) =>
      (await Promise.all((await membershipRows(principalId)).map(tie))).filter(
        (found): found is OrganizationTie => found !== undefined,
      ),
    leave: async (principalId, organizationId) => {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await leaveOnce(principalId, organizationId);
        } catch (cause) {
          if (attempt >= WRITE_ATTEMPTS || !isDatabaseWriteConflict(cause)) throw cause;
        }
      }
    },
  };
}
