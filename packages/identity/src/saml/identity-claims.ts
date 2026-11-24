import type { VerifiedAssertion } from "./verify.ts";

declare const samlIdentityClaimsBrand: unique symbol;

/**
 * The SAML sign-in input. Only `samlIdentityClaims` mints one, from a `VerifiedAssertion` that only
 * `verifySamlResponse` mints, so the email is the configured IdP's word. There is no
 * `emailVerified`: the sign-in store trusts the email only on a verified login domain of the org.
 */
export interface SamlIdentityClaims {
  readonly [samlIdentityClaimsBrand]: true;
  readonly protocol: "saml";
  /** The IdP entityID. */
  readonly issuer: string;
  /** The NameID. Links key on issuer and subject. */
  readonly subject: string;
  readonly email?: string;
  readonly displayName?: string;
  /** The AuthnInstant. */
  readonly authenticatedAt: string;
}

export type SamlIdentityClaimsDefect = "email_ambiguous";

export type SamlIdentityClaimsResult =
  | { readonly kind: "claims"; readonly claims: SamlIdentityClaims }
  | { readonly kind: "rejected"; readonly defect: SamlIdentityClaimsDefect };

const EMAIL_ADDRESS_FORMAT = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
const EMAIL_ATTRIBUTES = [
  "email",
  "mail",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "urn:oid:0.9.2342.19200300.100.1.3",
];
const DISPLAY_NAME_ATTRIBUTES = [
  "displayName",
  "http://schemas.microsoft.com/identity/claims/displayname",
  "name",
  "urn:oid:2.16.840.1.113730.3.1.241",
];
const GIVEN_NAME_ATTRIBUTES = [
  "givenName",
  "firstName",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
  "urn:oid:2.5.4.42",
];
const SURNAME_ATTRIBUTES = [
  "surname",
  "sn",
  "lastName",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
  "urn:oid:2.5.4.4",
];

/**
 * The email is the configured attribute when one is set, else the NameID when its format is
 * emailAddress, else the first default email attribute present. A configured attribute wins because
 * an emailAddress NameID is often a UPN that differs from the mailbox. An absent email is not a
 * defect here: the sign-in store denies it with the same `email_missing` reason OIDC uses.
 */
export function samlIdentityClaims(
  assertion: VerifiedAssertion,
  emailAttribute?: string,
): SamlIdentityClaimsResult {
  const { attributes } = assertion;
  const emails =
    emailAttribute !== undefined
      ? distinctValues(attributes, emailAttribute)
      : assertion.nameIdFormat === EMAIL_ADDRESS_FORMAT
        ? [assertion.nameId]
        : firstPresent(attributes, EMAIL_ATTRIBUTES);
  if (emails.length > 1) return { defect: "email_ambiguous", kind: "rejected" };
  const [email] = emails;

  const fullName = [GIVEN_NAME_ATTRIBUTES, SURNAME_ATTRIBUTES]
    .map((names) => firstPresent(attributes, names)[0])
    .filter((part) => part !== undefined)
    .join(" ");
  const displayName =
    firstPresent(attributes, DISPLAY_NAME_ATTRIBUTES)[0] ?? (fullName || undefined);

  const claims = {
    authenticatedAt: assertion.authnInstant,
    issuer: assertion.issuer,
    protocol: "saml" as const,
    subject: assertion.nameId,
    ...(displayName === undefined ? {} : { displayName }),
    ...(email === undefined ? {} : { email }),
  };
  return { claims: claims as SamlIdentityClaims, kind: "claims" };
}

function distinctValues(
  attributes: VerifiedAssertion["attributes"],
  name: string,
): readonly string[] {
  return [
    ...new Set(
      // An admin-configured name such as "constructor" must not reach Object.prototype.
      (Object.hasOwn(attributes, name) ? (attributes[name] ?? []) : [])
        .map((value) => value.trim())
        .filter((value) => value),
    ),
  ];
}

function firstPresent(
  attributes: VerifiedAssertion["attributes"],
  names: readonly string[],
): readonly string[] {
  for (const name of names) {
    const values = distinctValues(attributes, name);
    if (values.length > 0) return values;
  }
  return [];
}
