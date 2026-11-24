import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { makeFederationReads } from "../identity-federation/reads.ts";
import { key } from "../keys.ts";
import type { IdentitySecurityEventRecord } from "../records/identity-auth.ts";
import type { PrincipalRecord } from "../records/identity.ts";
import type { OrganizationMemberRecord, OrganizationRecord } from "../records/tenancy.ts";
import {
  decodeSystemCursor,
  encodeSystemCursor,
  runSystemPersistence,
  systemPageLimit,
  type SystemPage,
  type SystemPageOptions,
} from "./support.ts";

/** How many of a person's memberships the operator view reads; `membershipsCapped` says more may exist. */
export const PRINCIPAL_MEMBERSHIP_READ_LIMIT = 100;

type Principal = (typeof PrincipalRecord.Type)["data"];
type Member = (typeof OrganizationMemberRecord.Type)["data"];
type Organization = (typeof OrganizationRecord.Type)["data"];
export type PlatformPrincipalSecurityEvent = (typeof IdentitySecurityEventRecord.Type)["data"];

export interface PlatformPrincipalMembership {
  readonly joinedAt?: string;
  /** Absent once the organization record is gone. */
  readonly organization?: Pick<Organization, "name" | "slug" | "status">;
  readonly organizationId: string;
  readonly role: Member["role"];
  readonly status: Member["status"];
}

export interface PlatformPrincipal {
  readonly memberships: readonly PlatformPrincipalMembership[];
  readonly membershipsCapped: boolean;
  readonly principal: Principal;
}

/** Install-wide person reads for operators, across every organization. */
export interface PlatformPrincipalDirectory {
  /** The principal holding this normalized email's uniqueness claim. Exact match only. */
  readonly findByEmail: (normalizedEmail: string) => Promise<Principal | undefined>;
  readonly get: (principalId: Ulid) => Promise<PlatformPrincipal | undefined>;
  /** The person's identity security events, newest first, through the events table's GSI1. */
  readonly securityEvents: (
    principalId: Ulid,
    options?: SystemPageOptions,
  ) => Promise<SystemPage<PlatformPrincipalSecurityEvent>>;
}

const MEMBER_PREFIX = `${key("ORGANIZATION-MEMBER")}#`;

export function makePlatformPrincipalDirectory(
  database: DynamoDatabaseService,
): PlatformPrincipalDirectory {
  const reads = makeFederationReads(database);

  async function memberships(principalId: Ulid) {
    const page = await runSystemPersistence(
      "list a person's memberships",
      database.queryRecords("control", {
        ExpressionAttributeValues: {
          ":pk": key("PRINCIPAL", principalId),
          ":sk": MEMBER_PREFIX,
        },
        IndexName: "gsi2",
        KeyConditionExpression: "gsi2pk = :pk AND begins_with(gsi2sk, :sk)",
        Limit: PRINCIPAL_MEMBERSHIP_READ_LIMIT,
      }),
    );
    const members = page.items.flatMap((record) =>
      record.itemType === "organization-member" && record.data.principalId === principalId
        ? [record.data]
        : [],
    );
    const items = await Promise.all(
      members.map(async (member): Promise<PlatformPrincipalMembership> => {
        const organization = await runSystemPersistence(
          "read an organization",
          reads.organization(member.organizationId),
        );
        return {
          ...(member.joinedAt ? { joinedAt: member.joinedAt } : {}),
          ...(organization
            ? {
                organization: {
                  name: organization.data.name,
                  slug: organization.data.slug,
                  status: organization.data.status,
                },
              }
            : {}),
          organizationId: member.organizationId,
          role: member.role,
          status: member.status,
        };
      }),
    );
    return { capped: page.lastEvaluatedKey !== undefined, items };
  }

  return {
    async findByEmail(normalizedEmail) {
      const principal = await runSystemPersistence(
        "find a person by email",
        reads.principalForEmail(normalizedEmail),
      );
      return principal?.data;
    },
    async securityEvents(principalId, options = {}) {
      const partition = key("PRINCIPAL", principalId, "IDENTITY-SECURITY-EVENTS");
      const exclusiveStartKey = decodeSystemCursor(options.cursor, {
        partition,
        partitionField: "gsi1pk",
      });
      const page = await runSystemPersistence(
        "list a person's security events",
        database.queryRecords("events", {
          ExpressionAttributeValues: { ":pk": partition },
          IndexName: "gsi1",
          KeyConditionExpression: "gsi1pk = :pk",
          Limit: systemPageLimit(options.limit),
          ScanIndexForward: false,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      return {
        items: page.items.flatMap((record) =>
          record.itemType === "identity-security-event" && record.data.principalId === principalId
            ? [record.data]
            : [],
        ),
        ...(page.lastEvaluatedKey ? { nextCursor: encodeSystemCursor(page.lastEvaluatedKey) } : {}),
      };
    },
    async get(principalId) {
      const principal = await runSystemPersistence("read a person", reads.principal(principalId));
      if (!principal) return undefined;
      const { capped, items } = await memberships(principalId);
      return { memberships: items, membershipsCapped: capped, principal: principal.data };
    },
  };
}
