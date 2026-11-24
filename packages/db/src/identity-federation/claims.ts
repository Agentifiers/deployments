import { createHash } from "node:crypto";
import type { PrincipalIdentityRecord } from "../records/identity.ts";
import type { IdentityProviderData } from "../records/identity-federation.ts";
import type { PlatformRecord } from "../records/index.ts";
import { claimOwnerAttributes, claimRequirement } from "../unique-claim-requirement.ts";
import type { UniqueClaimRequirement } from "../unique-claims.ts";
import type { FederationItemType } from "./record-builders.ts";

export const VERIFIED_LOGIN_DOMAIN_CLAIM_NAMESPACE = "login-domain";

/** Value: sha256(issuer NUL assertion ID), so long entity IDs cannot overflow the claim key. */
export const SAML_ASSERTION_CLAIM_NAMESPACE = "saml-assertion";

/** A federation item type reaching a `default` arm below has no claim decision and fails tsc. */
type NonFederationItemType = Exclude<PlatformRecord["itemType"], FederationItemType>;

export function organizationLoginDomainClaimNamespace(organizationId: string) {
  return `organization:${organizationId}:login-domain`;
}

/** Where a link lives: its issuer and, for SAML, the connection that proved its subject. */
export type LinkAnchor = Pick<typeof PrincipalIdentityRecord.Type.data, "connectionId" | "issuer">;

/**
 * A SAML entity ID is whatever an organization admin typed, so a SAML link belongs to the
 * connection whose pinned certificates signed it. An OIDC issuer is proven by discovery.
 */
export function linkAnchor(provider: IdentityProviderData): LinkAnchor {
  return provider.protocol === "saml"
    ? { connectionId: provider.connectionId, issuer: provider.issuer }
    : { issuer: provider.issuer };
}

/** A NameID can be long, so SAML claims its hash to bound the claim key. */
export function principalIdentityClaim(anchor: LinkAnchor, subject: string) {
  return anchor.connectionId === undefined
    ? { namespace: `principal-identity:${anchor.issuer}`, value: subject }
    : {
        namespace: `principal-identity:saml:${anchor.connectionId}`,
        value: createHash("sha256").update(subject, "utf8").digest("hex"),
      };
}

export function federatedPrincipalClaimNamespace(organizationId: string) {
  return `organization:${organizationId}:federated-principal`;
}

export function federationClaimRequirements(
  record: PlatformRecord,
): readonly UniqueClaimRequirement[] {
  switch (record.itemType) {
    case "organization-login-domain":
      return [
        ...claimRequirement(
          record,
          organizationLoginDomainClaimNamespace(record.data.organizationId),
          record.data.domain,
        ),
        ...(record.data.state.kind === "verified"
          ? claimRequirement(record, VERIFIED_LOGIN_DOMAIN_CLAIM_NAMESPACE, record.data.domain)
          : []),
      ];
    case "principal-identity": {
      const identity = principalIdentityClaim(record.data, record.data.subject);
      return [
        ...claimRequirement(record, identity.namespace, identity.value),
        ...claimRequirement(
          record,
          federatedPrincipalClaimNamespace(record.data.organizationId),
          record.data.principalId,
        ),
      ];
    }
    case "identity-federation-unsolicited-sign-in":
      return claimRequirement(record, SAML_ASSERTION_CLAIM_NAMESPACE, record.data.assertionKey);
    case "identity-federation-link-request":
    case "identity-federation-transaction":
    case "organization-federated-grant":
    case "organization-identity-provider":
      return [];
    default:
      record.itemType satisfies NonFederationItemType;
      return [];
  }
}

export function federationClaimOwnerAttributes(
  record: PlatformRecord,
): Readonly<Record<string, unknown>> | undefined {
  switch (record.itemType) {
    case "organization-login-domain":
      return claimOwnerAttributes(record.data, ["organizationId", "domain"]);
    case "principal-identity":
      return claimOwnerAttributes(record.data, [
        "organizationId",
        "issuer",
        "subject",
        "principalId",
      ]);
    case "identity-federation-unsolicited-sign-in":
      return claimOwnerAttributes(record.data, ["organizationId", "assertionKey"]);
    case "identity-federation-link-request":
    case "identity-federation-transaction":
    case "organization-federated-grant":
    case "organization-identity-provider":
      return undefined;
    default:
      record.itemType satisfies NonFederationItemType;
      return undefined;
  }
}
