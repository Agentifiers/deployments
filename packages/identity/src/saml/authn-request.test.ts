import { inflateRawSync } from "node:zlib";

import { describe, expect, test } from "bun:test";

import { samlAuthnRedirectUrl } from "./authn-request.ts";

const request = {
  acsUrl: "https://auth.platform.test/saml/01J8ORGANIZATION0000000000/acs",
  forceAuthn: true,
  now: new Date("2026-10-18T08:00:00.000Z"),
  relayState: "01J8TRANSACTION00000000000",
  requestId: "_A1MmTNk0JMRgbNa6AmV1QScPlaJpp8Sh7GcO1EPhVC8",
  singleSignOnUrl:
    "https://login.microsoftonline.com/72f988bf-0000-0000-0000-2d7cd011db47/saml2?existing=1&RelayState=stale",
  spEntityId: "https://auth.platform.test/saml/01J8ORGANIZATION0000000000",
};

const inflated = (url: string) =>
  inflateRawSync(
    Buffer.from(new URL(url).searchParams.get("SAMLRequest") ?? "", "base64"),
  ).toString("utf8");

describe("samlAuthnRedirectUrl", () => {
  test("deflates an unsigned AuthnRequest into the sign-on URL and keeps its query", () => {
    const url = new URL(samlAuthnRedirectUrl(request));
    expect([...url.searchParams.keys()]).toEqual(["existing", "RelayState", "SAMLRequest"]);
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/72f988bf-0000-0000-0000-2d7cd011db47/saml2",
    );
    expect(url.searchParams.get("existing")).toBe("1");
    expect(url.searchParams.get("RelayState")).toBe("01J8TRANSACTION00000000000");
    expect(inflated(url.href)).toBe(
      `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"` +
        ` ID="_A1MmTNk0JMRgbNa6AmV1QScPlaJpp8Sh7GcO1EPhVC8" Version="2.0" IssueInstant="2026-10-18T08:00:00.000Z"` +
        ` Destination="https://login.microsoftonline.com/72f988bf-0000-0000-0000-2d7cd011db47/saml2?existing=1&amp;RelayState=stale"` +
        ` ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"` +
        ` AssertionConsumerServiceURL="https://auth.platform.test/saml/01J8ORGANIZATION0000000000/acs" ForceAuthn="true">` +
        `<saml:Issuer>https://auth.platform.test/saml/01J8ORGANIZATION0000000000</saml:Issuer></samlp:AuthnRequest>`,
    );
  });

  test("omits ForceAuthn unless reauthentication is required", () => {
    expect(inflated(samlAuthnRedirectUrl({ ...request, forceAuthn: false }))).not.toContain(
      "ForceAuthn",
    );
  });

  test("refuses a RelayState over 80 bytes", () => {
    expect(() => samlAuthnRedirectUrl({ ...request, relayState: "r".repeat(81) })).toThrow(
      "SAML RelayState exceeds 80 bytes",
    );
  });
});
