import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { Keys, key } from "../keys.ts";
import type { PlatformRecord } from "../records/index.ts";
import type {
  FederatedAuthentication,
  IdentitySessionAuthentication,
  OrganizationFederatedGrantRecord,
  OrganizationIdentityProviderRecord,
} from "../records/identity-federation.ts";
import { FEDERATED_AUTHENTICATION_MAX_AGE_SECONDS, federatedGrantExpiry } from "./operations.ts";
import { admittingOperatorAccess } from "../operator-access/lifecycle.ts";
import type { OrganizationOperatorAccess } from "../records/operator-access.ts";
import { federationRecord } from "./record-builders.ts";
import { identityProviderKey } from "./record-keys.ts";
import type { OrganizationRole } from "../tenancy-contracts.ts";

/** The operator access grant a platform administrator acts under in one organization. */
export interface OperatorAccessGrant {
  readonly expiresAt: string;
  readonly grantId: Ulid;
  readonly organizationId: Ulid;
}

export type OrganizationAccess =
  | { readonly kind: "platform-administrator"; readonly operatorAccess: OperatorAccessGrant }
  | { readonly kind: "member"; readonly role: OrganizationRole }
  | { readonly kind: "sso-required" }
  | { readonly kind: "operator-access-required" }
  | { readonly kind: "denied" };

export interface OrganizationAccessFacts {
  readonly grant: OrganizationFederatedGrantRecord["data"] | undefined;
  readonly member:
    | { readonly role: OrganizationRole; readonly status: "active" | "invited" | "removed" }
    | undefined;
  readonly now: Date;
  /** The stored operator access record for (organization, principal); read only for administrators. */
  readonly operatorAccess: OrganizationOperatorAccess | undefined;
  readonly organizationId: Ulid;
  readonly platformAdministrator: boolean;
  readonly principalId: Ulid;
  readonly provider: OrganizationIdentityProviderRecord["data"] | undefined;
}

export function federatedGrantSatisfies(input: {
  readonly grant: OrganizationFederatedGrantRecord["data"] | undefined;
  readonly now: Date;
  readonly principalId: Ulid;
  readonly provider: OrganizationIdentityProviderRecord["data"];
}): boolean {
  const { grant, provider } = input;
  return (
    grant !== undefined &&
    grant.organizationId === provider.organizationId &&
    grant.principalId === input.principalId &&
    grant.connectionId === provider.connectionId &&
    Date.parse(grant.expiresAt) > input.now.getTime()
  );
}

export function exemptFromSsoEnforcement(role: OrganizationRole | undefined): boolean {
  return role === "owner";
}

/**
 * An active member acts as a member, whether or not they are also a platform administrator: their
 * own access is never operator access. A platform administrator without active membership reads
 * tenant data only under an open, unexpired operator access grant for this organization.
 */
export function decideOrganizationAccess(facts: OrganizationAccessFacts): OrganizationAccess {
  if (facts.member?.status !== "active") {
    if (!facts.platformAdministrator) return { kind: "denied" };
    const access = admittingOperatorAccess(facts.operatorAccess, facts);
    return access
      ? {
          kind: "platform-administrator",
          operatorAccess: {
            expiresAt: access.expiresAt,
            grantId: access.grantId,
            organizationId: access.organizationId,
          },
        }
      : { kind: "operator-access-required" };
  }
  const { provider } = facts;
  const enforced =
    provider?.state.kind === "active" &&
    provider.state.enforcement === "required" &&
    !exemptFromSsoEnforcement(facts.member.role);
  if (!enforced) return { kind: "member", role: facts.member.role };
  return federatedGrantSatisfies({ ...facts, provider })
    ? { kind: "member", role: facts.member.role }
    : { kind: "sso-required" };
}

export function federatedSessionSatisfies(input: {
  readonly authentication: IdentitySessionAuthentication;
  readonly now: Date;
  readonly provider: OrganizationIdentityProviderRecord["data"];
}): boolean {
  const { authentication, provider } = input;
  return (
    authentication.method === "federated" &&
    authentication.organizationId === provider.organizationId &&
    authentication.connectionId === provider.connectionId &&
    Date.parse(authentication.authenticatedAt) + FEDERATED_AUTHENTICATION_MAX_AGE_SECONDS * 1_000 >
      input.now.getTime()
  );
}

export function federatedGrantRecord(input: {
  readonly authentication: FederatedAuthentication;
  readonly createdAt: string;
  readonly principalId: Ulid;
  readonly tokenSessionExpiresAt: string;
  readonly tokenSessionId: Ulid;
}): OrganizationFederatedGrantRecord {
  const { authentication } = input;
  return federationRecord("organization-federated-grant", {
    authenticatedAt: authentication.authenticatedAt,
    connectionId: authentication.connectionId,
    createdAt: input.createdAt,
    expiresAt: federatedGrantExpiry({
      authenticatedAt: authentication.authenticatedAt,
      tokenSessionExpiresAt: input.tokenSessionExpiresAt,
    }),
    id: input.tokenSessionId,
    issuer: authentication.issuer,
    organizationId: authentication.organizationId,
    principalId: input.principalId,
    subject: authentication.subject,
  });
}

function recordOf<ItemType extends PlatformRecord["itemType"]>(
  itemType: ItemType,
  record: PlatformRecord | undefined,
) {
  return record?.itemType === itemType
    ? (record as Extract<PlatformRecord, { readonly itemType: ItemType }>)
    : undefined;
}

export async function organizationAccess(
  database: DynamoDatabaseService,
  input: {
    readonly now?: Date;
    readonly organizationId: Ulid;
    readonly platformAdministrator: boolean;
    readonly principalId: Ulid;
    readonly tokenSessionId?: Ulid;
  },
): Promise<OrganizationAccess> {
  const partition = key("ORG", input.organizationId);
  const read = (sk: string) => database.getRecord("control", { pk: partition, sk }, true);
  const [member, provider, grant, operatorAccess] = await Promise.all([
    read(key("ORGANIZATION-MEMBER", input.principalId)),
    database.getRecord("control", identityProviderKey(input.organizationId), true),
    input.tokenSessionId
      ? read(key("ORGANIZATION-FEDERATED-GRANT", input.tokenSessionId))
      : Promise.resolve(undefined),
    input.platformAdministrator
      ? database.getRecord(
          "control",
          Keys.control.organizationOperatorAccess(input.organizationId, input.principalId),
          true,
        )
      : Promise.resolve(undefined),
  ]);
  return decideOrganizationAccess({
    grant: recordOf("organization-federated-grant", grant)?.data,
    member: recordOf("organization-member", member)?.data,
    now: input.now ?? new Date(),
    operatorAccess: recordOf("organization-operator-access", operatorAccess)?.data,
    organizationId: input.organizationId,
    platformAdministrator: input.platformAdministrator,
    principalId: input.principalId,
    provider: recordOf("organization-identity-provider", provider)?.data,
  });
}
