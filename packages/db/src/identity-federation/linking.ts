import type { SamlIdentityClaims } from "@deployments-ai/identity/saml";
import type { Ulid } from "../ids.ts";
import type {
  FederationJitPolicy,
  FederationJitRole,
  IdentityProviderProtocol,
} from "../records/identity-federation.ts";

export const GOOGLE_ISSUER = "https://accounts.google.com";

export interface OidcIdentityClaims {
  readonly email?: string;
  readonly emailVerified?: boolean;
  readonly entraEmailDomainOwnerVerified?: boolean;
  readonly hostedDomain?: string;
  readonly issuer: string;
  readonly name?: string;
  readonly protocol: "oidc";
  readonly subject: string;
}

export type FederatedIdentityClaims = OidcIdentityClaims | SamlIdentityClaims;

export interface FederatedAssertion {
  readonly displayName?: string;
  readonly email: string;
  readonly emailDomain: string;
  readonly issuer: string;
  readonly protocol: IdentityProviderProtocol;
  readonly subject: string;
}

export type FederationDenial =
  | "connection_inactive"
  | "email_domain_not_verified"
  | "email_missing"
  | "email_unverified"
  | "hosted_domain_mismatch"
  | "principal_ineligible";

export type AssertionResult =
  | { readonly kind: "asserted"; readonly assertion: FederatedAssertion }
  | { readonly kind: "denied"; readonly reason: FederationDenial };

const EMAIL_PATTERN = /^[^\s@]+@([^\s@]+)$/u;

export function normalizedEmailDomain(email: string | undefined): string | undefined {
  return email?.trim().toLowerCase().match(EMAIL_PATTERN)?.[1];
}

/**
 * OIDC needs the IdP's own email verdict, and Google also needs `hd` equal to the email domain,
 * because consumer Google accounts can hold any verified address. A SAML email needs only to be
 * present: the signed assertion is the configured IdP's word, and sign-in admits it only on a
 * verified login domain of the organization.
 */
export function federatedAssertion(claims: FederatedIdentityClaims): AssertionResult {
  const email = claims.email?.trim().toLowerCase();
  const emailDomain = normalizedEmailDomain(email);
  if (!email || !emailDomain) return { kind: "denied", reason: "email_missing" };
  let displayName: string | undefined;
  switch (claims.protocol) {
    case "oidc":
      if (claims.emailVerified !== true && claims.entraEmailDomainOwnerVerified !== true) {
        return { kind: "denied", reason: "email_unverified" };
      }
      if (claims.issuer === GOOGLE_ISSUER && claims.hostedDomain?.toLowerCase() !== emailDomain) {
        return { kind: "denied", reason: "hosted_domain_mismatch" };
      }
      displayName = claims.name?.trim();
      break;
    case "saml":
      displayName = claims.displayName?.trim();
      break;
    default: {
      const unhandled: never = claims;
      return unhandled;
    }
  }
  return {
    assertion: {
      ...(displayName ? { displayName } : {}),
      email,
      emailDomain,
      issuer: claims.issuer,
      protocol: claims.protocol,
      subject: claims.subject,
    },
    kind: "asserted",
  };
}

export interface LinkingPrincipal {
  readonly id: Ulid;
  readonly kind: "human" | "service" | "support";
  readonly platformRole?: "administrator" | undefined;
  readonly primaryEmail?: string | undefined;
  readonly status: "active" | "archived" | "disabled";
}

/**
 * What sign-in read about a principal that this organization's directory provisioned. `evidence`
 * is whatever the caller must pin when it writes the link.
 */
export interface ProvisionedStanding<Evidence> {
  readonly evidence: Evidence;
  readonly linkedHere: boolean;
  readonly memberElsewhere: boolean;
  readonly membershipActive: boolean;
  readonly passwordSet: boolean;
  readonly sessionEpoch: number;
}

export type PrincipalDecision<Evidence> =
  | { readonly kind: "sign-in"; readonly principalId: Ulid }
  | { readonly kind: "create" }
  | { readonly kind: "confirm-mailbox"; readonly principalId: Ulid }
  | { readonly kind: "link"; readonly principalId: Ulid; readonly evidence: Evidence }
  | { readonly kind: "denied"; readonly reason: FederationDenial };

function federable(principal: LinkingPrincipal) {
  return (
    principal.kind === "human" &&
    principal.status === "active" &&
    principal.platformRole === undefined &&
    principal.primaryEmail !== undefined
  );
}

/**
 * Nobody but the directory has used the account: link confirmation always ends sessions, so a
 * session epoch of 0 means it never linked anywhere.
 */
function pristine(standing: ProvisionedStanding<unknown>) {
  return (
    standing.membershipActive &&
    !standing.passwordSet &&
    standing.sessionEpoch === 0 &&
    !standing.linkedHere &&
    !standing.memberElsewhere
  );
}

export function decidePrincipal<Evidence>(input: {
  readonly assertion: FederatedAssertion;
  readonly link: LinkingPrincipal | undefined;
  readonly principalByEmail: LinkingPrincipal | undefined;
  /** Present only when this organization's directory provisioned `principalByEmail`. */
  readonly provisioned: ProvisionedStanding<Evidence> | undefined;
  readonly verifiedDomains: ReadonlySet<string>;
}): PrincipalDecision<Evidence> {
  if (input.link) {
    if (!federable(input.link)) return { kind: "denied", reason: "principal_ineligible" };
    const domain = normalizedEmailDomain(input.link.primaryEmail);
    return domain && input.verifiedDomains.has(domain)
      ? { kind: "sign-in", principalId: input.link.id }
      : { kind: "denied", reason: "email_domain_not_verified" };
  }
  if (!input.verifiedDomains.has(input.assertion.emailDomain)) {
    return { kind: "denied", reason: "email_domain_not_verified" };
  }
  const principal = input.principalByEmail;
  if (!principal) return { kind: "create" };
  if (!federable(principal)) return { kind: "denied", reason: "principal_ineligible" };
  return input.provisioned && pristine(input.provisioned)
    ? { evidence: input.provisioned.evidence, kind: "link", principalId: principal.id }
    : { kind: "confirm-mailbox", principalId: principal.id };
}

export type JitDecision =
  | { readonly kind: "create"; readonly role: FederationJitRole }
  | { readonly kind: "none" };

export function jitMembership(
  existing: { readonly status: "active" | "invited" | "removed" } | undefined,
  policy: FederationJitPolicy,
): JitDecision {
  return existing === undefined && policy.kind === "enabled"
    ? { kind: "create", role: policy.role }
    : { kind: "none" };
}
