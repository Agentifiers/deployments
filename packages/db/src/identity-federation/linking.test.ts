import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  decidePrincipal,
  federatedAssertion,
  jitMembership,
  type FederatedAssertion,
  type LinkingPrincipal,
} from "./linking.ts";
import { samlClaims, SAML_ISSUER } from "./saml-test-support.ts";

const id = Schema.decodeUnknownSync(Ulid);
const VICTIM = id("01ARZ3NDEKTSV4RRFFQ69G5FB1");
const OTHER = id("01ARZ3NDEKTSV4RRFFQ69G5FB2");
const OKTA = "https://acme.okta.com";

function human(principalId: Ulid, primaryEmail: string): LinkingPrincipal {
  return { id: principalId, kind: "human", primaryEmail, status: "active" };
}

function asserted(email: string, issuer = OKTA): FederatedAssertion {
  const result = federatedAssertion({
    email,
    emailVerified: true,
    issuer,
    protocol: "oidc",
    subject: "sub-1",
  });
  if (result.kind !== "asserted") throw new Error(`expected an assertion, got ${result.reason}`);
  return result.assertion;
}

describe("federated email authority", () => {
  test("normalizes a verified email into the assertion", () => {
    expect(
      federatedAssertion({
        email: "  Alice@Acme.COM ",
        emailVerified: true,
        issuer: OKTA,
        protocol: "oidc",
        subject: "00u1",
      }),
    ).toEqual({
      assertion: {
        email: "alice@acme.com",
        emailDomain: "acme.com",
        issuer: OKTA,
        protocol: "oidc",
        subject: "00u1",
      },
      kind: "asserted",
    });
  });

  test("a SAML assertion needs only an email, never an email verdict", () => {
    expect(federatedAssertion(samlClaims({ email: "  Dana@Acme.COM " }))).toEqual({
      assertion: {
        displayName: "Dana Example",
        email: "dana@acme.com",
        emailDomain: "acme.com",
        issuer: SAML_ISSUER,
        protocol: "saml",
        subject: "dana-subject",
      },
      kind: "asserted",
    });
    expect(federatedAssertion(samlClaims({}))).toEqual({
      kind: "denied",
      reason: "email_missing",
    });
  });

  test("denies email_verified false, absent, and a missing email", () => {
    const base = { issuer: OKTA, protocol: "oidc", subject: "00u1" } as const;
    expect(federatedAssertion({ ...base, email: "a@acme.com", emailVerified: false })).toEqual({
      kind: "denied",
      reason: "email_unverified",
    });
    expect(federatedAssertion({ ...base, email: "a@acme.com" })).toEqual({
      kind: "denied",
      reason: "email_unverified",
    });
    expect(federatedAssertion({ ...base, emailVerified: true })).toEqual({
      kind: "denied",
      reason: "email_missing",
    });
  });

  test("accepts Entra's domain-owner-verified flag in place of email_verified", () => {
    const issuer = "https://login.microsoftonline.com/7a1d/v2.0";
    expect(
      federatedAssertion({
        email: "bob@acme.com",
        entraEmailDomainOwnerVerified: true,
        issuer,
        subject: "AAA",
        protocol: "oidc",
      }).kind,
    ).toBe("asserted");
  });

  test("Google needs hd equal to the email domain", () => {
    const google = {
      email: "carol@acme.com",
      emailVerified: true,
      issuer: "https://accounts.google.com",
      subject: "1077",
      protocol: "oidc",
    } as const;

    expect(federatedAssertion(google)).toEqual({
      kind: "denied",
      reason: "hosted_domain_mismatch",
    });
    expect(federatedAssertion({ ...google, hostedDomain: "evil.com" })).toEqual({
      kind: "denied",
      reason: "hosted_domain_mismatch",
    });
    expect(federatedAssertion({ ...google, hostedDomain: "acme.com" }).kind).toBe("asserted");
  });
});

describe("principal linking attack matrix", () => {
  const PRISTINE = {
    evidence: "pinned records",
    linkedHere: false,
    memberElsewhere: false,
    membershipActive: true,
    passwordSet: false,
    sessionEpoch: 0,
  };

  test("an attacker IdP asserting a victim email in another org's verified domain is denied", () => {
    expect(
      decidePrincipal({
        assertion: asserted("ceo@victim.com", "https://attacker.example"),
        link: undefined,
        principalByEmail: human(VICTIM, "ceo@victim.com"),
        provisioned: PRISTINE,
        verifiedDomains: new Set(["attacker.example"]),
      }),
    ).toEqual({ kind: "denied", reason: "email_domain_not_verified" });
  });

  test("a link whose principal's domain is no longer verified is denied", () => {
    expect(
      decidePrincipal({
        assertion: asserted("alice@acme.com"),
        link: human(VICTIM, "alice@acme.com"),
        principalByEmail: undefined,
        provisioned: undefined,
        verifiedDomains: new Set(),
      }),
    ).toEqual({ kind: "denied", reason: "email_domain_not_verified" });
  });

  test("a link never moves when the asserted email changes", () => {
    expect(
      decidePrincipal({
        assertion: asserted("someone-else@acme.com"),
        link: human(VICTIM, "alice@acme.com"),
        principalByEmail: human(OTHER, "someone-else@acme.com"),
        provisioned: undefined,
        verifiedDomains: new Set(["acme.com"]),
      }),
    ).toEqual({ kind: "sign-in", principalId: VICTIM });
  });

  test("no link plus an existing principal asks for mailbox confirmation unless provisioned pristine", () => {
    const input = {
      assertion: asserted("alice@acme.com"),
      link: undefined,
      principalByEmail: human(VICTIM, "alice@acme.com"),
      verifiedDomains: new Set(["acme.com"]),
    };
    expect(decidePrincipal({ ...input, provisioned: undefined })).toEqual({
      kind: "confirm-mailbox",
      principalId: VICTIM,
    });
    expect(decidePrincipal({ ...input, provisioned: { ...PRISTINE, passwordSet: true } })).toEqual({
      kind: "confirm-mailbox",
      principalId: VICTIM,
    });
    expect(decidePrincipal({ ...input, provisioned: PRISTINE })).toEqual({
      evidence: "pinned records",
      kind: "link",
      principalId: VICTIM,
    });
  });

  test("no link and no principal creates one only inside a verified domain", () => {
    const input = {
      assertion: asserted("new@acme.com"),
      link: undefined,
      principalByEmail: undefined,
      provisioned: undefined,
    };
    expect(decidePrincipal({ ...input, verifiedDomains: new Set(["acme.com"]) })).toEqual({
      kind: "create",
    });
    expect(decidePrincipal({ ...input, verifiedDomains: new Set(["sub.acme.com"]) })).toEqual({
      kind: "denied",
      reason: "email_domain_not_verified",
    });
  });

  test("platform administrators and non-human principals are never federated", () => {
    const verifiedDomains = new Set(["acme.com"]);
    const administrator: LinkingPrincipal = {
      ...human(VICTIM, "root@acme.com"),
      platformRole: "administrator",
    };
    const service: LinkingPrincipal = { ...human(OTHER, "bot@acme.com"), kind: "service" };
    const disabled: LinkingPrincipal = { ...human(OTHER, "gone@acme.com"), status: "disabled" };
    for (const principal of [administrator, service, disabled]) {
      expect(
        decidePrincipal({
          assertion: asserted(principal.primaryEmail ?? ""),
          link: principal,
          principalByEmail: undefined,
          provisioned: undefined,
          verifiedDomains,
        }),
      ).toEqual({ kind: "denied", reason: "principal_ineligible" });
      expect(
        decidePrincipal({
          assertion: asserted(principal.primaryEmail ?? ""),
          link: undefined,
          principalByEmail: principal,
          provisioned: PRISTINE,
          verifiedDomains,
        }),
      ).toEqual({ kind: "denied", reason: "principal_ineligible" });
    }
  });
});

describe("just-in-time membership", () => {
  const enabled = { kind: "enabled", role: "viewer" } as const;

  test("creates a membership with the policy role only when none exists", () => {
    expect(jitMembership(undefined, enabled)).toEqual({ kind: "create", role: "viewer" });
    expect(jitMembership(undefined, { kind: "disabled" })).toEqual({ kind: "none" });
  });

  test("never revives removed or invited members and never overwrites an active one", () => {
    expect(jitMembership({ status: "removed" }, enabled)).toEqual({ kind: "none" });
    expect(jitMembership({ status: "invited" }, enabled)).toEqual({ kind: "none" });
    expect(jitMembership({ status: "active" }, enabled)).toEqual({ kind: "none" });
  });
});
