import { createHash } from "node:crypto";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { Keys, key } from "../keys.ts";
import type { PlatformRecord, TableName } from "../records/index.ts";
import {
  VERIFIED_LOGIN_DOMAIN_CLAIM_NAMESPACE,
  federatedPrincipalClaimNamespace,
  organizationLoginDomainClaimNamespace,
  principalIdentityClaim,
  type LinkAnchor,
} from "./claims.ts";
import { identityProviderKey, passwordCredentialKey } from "./record-keys.ts";

type RecordOf<ItemType extends PlatformRecord["itemType"]> = Extract<
  PlatformRecord,
  { readonly itemType: ItemType }
>;

function narrow<ItemType extends PlatformRecord["itemType"]>(
  itemType: ItemType,
  record: PlatformRecord | undefined,
): RecordOf<ItemType> | undefined {
  return record?.itemType === itemType ? (record as RecordOf<ItemType>) : undefined;
}

export function emailClaimHash(email: string) {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export function makeFederationReads(database: DynamoDatabaseService) {
  const get = <ItemType extends PlatformRecord["itemType"]>(
    table: TableName,
    itemType: ItemType,
    recordKey: { readonly pk: string; readonly sk: string },
  ) => database.getRecord(table, recordKey, true).then((record) => narrow(itemType, record));

  async function claimed<ItemType extends PlatformRecord["itemType"]>(
    itemType: ItemType,
    namespace: string,
    value: string,
  ) {
    const claim = await get("control", "unique-claim", Keys.control.uniqueClaim(namespace, value));
    if (!claim || claim.data.ownerItemType !== itemType) return undefined;
    return get(claim.data.ownerTable, itemType, { pk: claim.data.ownerPk, sk: claim.data.ownerSk });
  }

  return {
    link: (anchor: LinkAnchor, subject: string) => {
      const claim = principalIdentityClaim(anchor, subject);
      return claimed("principal-identity", claim.namespace, claim.value);
    },
    loginDomain: (organizationId: Ulid, domain: string) =>
      claimed(
        "organization-login-domain",
        organizationLoginDomainClaimNamespace(organizationId),
        domain,
      ),
    member: (organizationId: Ulid, principalId: Ulid) =>
      get("control", "organization-member", {
        pk: key("ORG", organizationId),
        sk: key("ORGANIZATION-MEMBER", principalId),
      }),
    organization: (organizationId: Ulid) =>
      get("control", "organization", {
        pk: key("ORG", organizationId),
        sk: key("ORG", organizationId),
      }),
    organizationLink: (organizationId: Ulid, principalId: Ulid) =>
      claimed("principal-identity", federatedPrincipalClaimNamespace(organizationId), principalId),
    principal: (principalId: Ulid) =>
      get("control", "principal", {
        pk: key("PRINCIPAL", principalId),
        sk: key("PRINCIPAL", principalId),
      }),
    principalForEmail: (email: string) =>
      claimed("principal", "principal-email", emailClaimHash(email)),
    passwordCredential: (principalId: Ulid) =>
      get("identity", "principal-credential", passwordCredentialKey(principalId)),
    provider: (organizationId: Ulid) =>
      get("control", "organization-identity-provider", identityProviderKey(organizationId)),
    securityState: (principalId: Ulid) =>
      get("identity", "principal-security-state", {
        pk: key("PRINCIPAL", principalId),
        sk: key("PRINCIPAL-SECURITY-STATE", "current"),
      }),
    bffFence: (principalId: Ulid) =>
      get("identity", "identity-bff-revocation-fence", {
        pk: key("BFF-IDENTITY-FENCE", principalId),
        sk: key("BFF-IDENTITY-FENCE", principalId),
      }),
    verifiedDomainOwner: (domain: string) =>
      claimed("organization-login-domain", VERIFIED_LOGIN_DOMAIN_CLAIM_NAMESPACE, domain),
    transaction: (lookupHash: string) =>
      get("identity", "identity-federation-transaction", {
        pk: key("IDENTITY-FEDERATION-TRANSACTION", lookupHash),
        sk: key("IDENTITY-FEDERATION-TRANSACTION", lookupHash),
      }),
    linkRequest: (tokenHash: string) =>
      get("identity", "identity-federation-link-request", {
        pk: key("IDENTITY-FEDERATION-LINK-REQUEST", tokenHash),
        sk: key("IDENTITY-FEDERATION-LINK-REQUEST", tokenHash),
      }),
    unsolicitedSignIn: (tokenHash: string) =>
      get("identity", "identity-federation-unsolicited-sign-in", {
        pk: key("IDENTITY-FEDERATION-UNSOLICITED-SIGN-IN", tokenHash),
        sk: key("IDENTITY-FEDERATION-UNSOLICITED-SIGN-IN", tokenHash),
      }),
  };
}

export type FederationReads = ReturnType<typeof makeFederationReads>;
