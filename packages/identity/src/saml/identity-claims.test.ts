import { describe, expect, test } from "bun:test";

import { samlIdentityClaims } from "./identity-claims.ts";
import {
  NOW,
  PERSISTENT_FORMAT,
  type ResponseOptions,
  responseXml,
  trust,
} from "./testing/saml-identity-provider.ts";
import { verifySamlResponse } from "./verify.ts";

const attribute = (name: string, ...values: string[]) =>
  `<saml:Attribute Name="${name}">${values.map((value) => `<saml:AttributeValue>${value}</saml:AttributeValue>`).join("")}</saml:Attribute>`;

const claimsFor = (options: ResponseOptions, emailAttribute?: string) => {
  const verified = verifySamlResponse(responseXml(options), trust, NOW);
  if (verified.kind === "rejected") throw new Error(`fixture rejected: ${verified.defect}`);
  return samlIdentityClaims(verified.assertion, emailAttribute);
};
const persistent = (attributes: string): ResponseOptions => ({
  attributes,
  nameId: "00u1abcdPERSIST",
  nameIdFormat: PERSISTENT_FORMAT,
});

describe("samlIdentityClaims", () => {
  test("takes the email from an emailAddress NameID over any attribute", () => {
    expect<unknown>(
      claimsFor({
        attributes: attribute("email", "other@acme.test") + attribute("name", "Alice Example"),
      }),
    ).toEqual({
      claims: {
        authenticatedAt: "2026-10-18T07:59:58.000Z",
        displayName: "Alice Example",
        email: "alice@acme.test",
        issuer: "https://idp.example.test/metadata",
        protocol: "saml",
        subject: "alice@acme.test",
      },
      kind: "claims",
    });
  });

  test("falls back to the default email attributes and composes a name from Entra claims", () => {
    expect<unknown>(
      claimsFor(
        persistent(
          attribute(
            "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
            "ada@acme.test",
          ) +
            attribute("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname", "Ada") +
            attribute("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname", "Lovelace"),
        ),
      ),
    ).toEqual({
      claims: {
        authenticatedAt: "2026-10-18T07:59:58.000Z",
        displayName: "Ada Lovelace",
        email: "ada@acme.test",
        issuer: "https://idp.example.test/metadata",
        protocol: "saml",
        subject: "00u1abcdPERSIST",
      },
      kind: "claims",
    });
  });

  test("prefers the first default email attribute present", () => {
    const result = claimsFor(
      persistent(attribute("mail", "mail@acme.test") + attribute("email", "email@acme.test")),
    );
    expect(result.kind === "claims" && result.claims.email).toBe("email@acme.test");
  });

  test("reads only the configured email attribute when one is set", () => {
    const configured = claimsFor(
      persistent(attribute("upn", "ada@acme.test") + attribute("email", "other@acme.test")),
      "upn",
    );
    expect(configured.kind === "claims" && configured.claims.email).toBe("ada@acme.test");

    const missing = claimsFor(persistent(attribute("email", "other@acme.test")), "upn");
    expect(missing.kind === "claims" && "email" in missing.claims).toBe(false);
  });

  test("prefers a configured email attribute over an emailAddress NameID", () => {
    const configured = claimsFor(
      { attributes: attribute("mail", "ada@acme.test"), nameId: "ada.lovelace@acme.test" },
      "mail",
    );
    expect<unknown>(configured).toEqual({
      claims: {
        authenticatedAt: "2026-10-18T07:59:58.000Z",
        email: "ada@acme.test",
        issuer: "https://idp.example.test/metadata",
        protocol: "saml",
        subject: "ada.lovelace@acme.test",
      },
      kind: "claims",
    });

    const missing = claimsFor({ attributes: attribute("email", "ada@acme.test") }, "mail");
    expect(missing.kind === "claims" && "email" in missing.claims).toBe(false);
  });

  test("ignores a configured attribute name that only exists on Object.prototype", () => {
    const result = claimsFor(persistent(attribute("email", "other@acme.test")), "constructor");
    expect(result.kind === "claims" && "email" in result.claims).toBe(false);
  });

  test("leaves the email and display name out when no attribute carries them", () => {
    expect<unknown>(claimsFor(persistent(attribute("groups", "eng")))).toEqual({
      claims: {
        authenticatedAt: "2026-10-18T07:59:58.000Z",
        issuer: "https://idp.example.test/metadata",
        protocol: "saml",
        subject: "00u1abcdPERSIST",
      },
      kind: "claims",
    });
  });

  test("accepts a repeated email value and rejects two different ones", () => {
    const repeated = claimsFor(persistent(attribute("email", "ada@acme.test", " ada@acme.test ")));
    expect(repeated.kind === "claims" && repeated.claims.email).toBe("ada@acme.test");
    expect(claimsFor(persistent(attribute("email", "ada@acme.test", "eve@acme.test")))).toEqual({
      defect: "email_ambiguous",
      kind: "rejected",
    });
  });
});
