import { pinnedFederationHttp } from "@deployments-ai/identity";
import {
  entraMetadata,
  IDP_CERTIFICATE,
  oktaMetadata,
} from "@deployments-ai/identity/saml-testing";
import { describe, expect, test } from "bun:test";
import { SECRET, okta, setup } from "./identity-federation-api.fixture.ts";

const METADATA_URL = "https://acme.okta.com/app/exk1a2b3c4d5e6f7g8h9/sso/saml/metadata";
const ULID = expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
const TIMESTAMP = expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
const IDP_SIGNING_CERTIFICATE = {
  notAfter: "2036-10-15T07:22:14.000Z",
  sha256Fingerprint:
    "3A:6F:9B:B2:85:59:D3:5F:0F:EE:87:A6:C8:02:99:B9:0A:50:5C:AF:8C:FE:59:26:B9:59:70:00:14:8C:62:21",
};
const OIDC_RESPONSE_KEYS = [
  "clientId",
  "clientSecretSetAt",
  "connectionId",
  "createdAt",
  "displayName",
  "endpoints",
  "issuer",
  "jit",
  "organizationId",
  "protocol",
  "redirectUri",
  "signingAlgorithms",
  "state",
  "tokenEndpointAuthMethod",
  "updatedAt",
];

const samlByUrl = {
  displayName: "Acme Okta SAML",
  emailAttribute: "email",
  jit: { kind: "enabled", role: "member" },
  metadata: { url: METADATA_URL },
  protocol: "saml",
};

async function oktaServed() {
  const fixture = await setup();
  fixture.served.set(METADATA_URL, { body: oktaMetadata, headers: new Headers(), status: 200 });
  return fixture;
}

describe("SAML identity provider administration", () => {
  test("saves a provider from its metadata URL and returns the values to register with it", async () => {
    const { acme, send } = await oktaServed();
    const saved = await send("admin", "PUT", "/v1/identity-provider", samlByUrl);

    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({
      connectionId: ULID,
      createdAt: TIMESTAMP,
      displayName: "Acme Okta SAML",
      emailAttribute: "email",
      issuer: "http://www.okta.com/exk1a2b3c4d5e6f7g8h9",
      jit: { kind: "enabled", role: "member" },
      metadataUrl: METADATA_URL,
      organizationId: acme,
      protocol: "saml",
      serviceProvider: {
        acsUrl: `https://auth.example.test/saml/${acme}/acs`,
        entityId: `https://auth.example.test/saml/${acme}`,
        metadataUrl: `https://auth.example.test/saml/${acme}/metadata`,
      },
      signingCertificates: [IDP_SIGNING_CERTIFICATE],
      singleSignOnUrl: "https://acme.okta.com/app/acme_platform/exk1a2b3c4d5e6f7g8h9/sso/saml",
      state: { enforcement: "optional", kind: "active" },
      unsolicitedSignIn: "disabled",
      updatedAt: TIMESTAMP,
    });
    expect(await send("admin", "GET", "/v1/identity-provider")).toMatchObject({
      body: saved.body,
      status: 200,
    });
  });

  test("saves a provider from a pasted metadata document and never returns certificate bodies", async () => {
    const { send } = await setup();
    const saved = await send("owner", "PUT", "/v1/identity-provider", {
      displayName: "Contoso Entra",
      jit: { kind: "disabled" },
      metadata: { document: `${entraMetadata}\n` },
      protocol: "saml",
      unsolicitedSignIn: "enabled",
    });

    expect(saved.status).toBe(200);
    expect({
      hasMetadataUrl: Object.hasOwn(saved.body, "metadataUrl"),
      issuer: saved.body.issuer,
      signingCertificates: saved.body.signingCertificates,
      singleSignOnUrl: saved.body.singleSignOnUrl,
      unsolicitedSignIn: saved.body.unsolicitedSignIn,
    }).toEqual({
      hasMetadataUrl: false,
      issuer: "https://sts.windows.net/72f988bf-0000-0000-0000-2d7cd011db47/",
      signingCertificates: [
        IDP_SIGNING_CERTIFICATE,
        {
          notAfter: "2036-10-15T07:23:05.000Z",
          sha256Fingerprint:
            "8D:54:90:69:A0:62:3F:D5:54:D5:8B:5C:1D:A1:A9:7B:9D:F6:D6:0E:AC:50:CE:B3:D6:F9:35:E0:74:A4:3E:CF",
        },
      ],
      singleSignOnUrl:
        "https://login.microsoftonline.com/72f988bf-0000-0000-0000-2d7cd011db47/saml2",
      unsolicitedSignIn: "enabled",
    });
    const fetched = await send("admin", "GET", "/v1/identity-provider");
    for (const response of [saved, fetched]) {
      expect(response.text).not.toContain(IDP_CERTIFICATE.slice(0, 64));
      expect(response.text).toContain("3A:6F:9B:B2");
    }
  });

  test("answers 422 for untrustworthy metadata, a refused URL, and a failed fetch, saving nothing", async () => {
    const { send, served } = await oktaServed();
    const failing = "https://acme.okta.com/app/failing/sso/saml/metadata";
    served.set(failing, { body: oktaMetadata, headers: new Headers(), status: 500 });
    const put = (metadata: unknown) =>
      send("admin", "PUT", "/v1/identity-provider", { ...samlByUrl, metadata });

    expect(
      await put({ document: oktaMetadata.replace("?>", "?><!DOCTYPE md:EntityDescriptor>") }),
    ).toMatchObject({
      body: {
        code: "metadata_doctype_forbidden",
        detail: "SAML metadata must not contain a DOCTYPE.",
      },
      status: 422,
    });
    expect(
      await put({ document: oktaMetadata.replace("HTTP-Redirect", "HTTP-Artifact") }),
    ).toMatchObject({ body: { code: "metadata_redirect_binding_missing" }, status: 422 });
    expect(await put({ url: failing })).toMatchObject({
      body: { code: "idp_request_failed" },
      status: 422,
    });
    expect(await put({ document: oktaMetadata, url: METADATA_URL })).toMatchObject({
      body: { code: "validation_failed" },
      status: 422,
    });

    const pinned = await setup({ federationHttp: pinnedFederationHttp() });
    for (const url of ["https://127.0.0.1/metadata", "http://acme.okta.com/metadata"]) {
      expect(
        await pinned.send("admin", "PUT", "/v1/identity-provider", {
          ...samlByUrl,
          metadata: { url },
        }),
      ).toMatchObject({ body: { code: "idp_url_not_allowed" }, status: 422 });
    }
    expect(await send("admin", "GET", "/v1/identity-provider")).toMatchObject({
      body: { code: "identity_provider_not_found" },
      status: 404,
    });
  });

  test("switches from OIDC to SAML and back, needing a client secret to return", async () => {
    const { send } = await oktaServed();
    const oidc = await send("owner", "PUT", "/v1/identity-provider", {
      ...okta,
      clientSecret: SECRET,
    });
    expect(oidc.body.protocol).toBe("oidc");

    const saml = await send("owner", "PUT", "/v1/identity-provider", samlByUrl);
    expect(saml.body).toMatchObject({
      issuer: "http://www.okta.com/exk1a2b3c4d5e6f7g8h9",
      protocol: "saml",
    });
    expect(saml.body.connectionId).not.toBe(oidc.body.connectionId);

    expect(
      await send("owner", "PUT", "/v1/identity-provider", { ...okta, protocol: "oidc" }),
    ).toMatchObject({ body: { code: "client_secret_required" }, status: 422 });
    expect((await send("admin", "GET", "/v1/identity-provider")).body.protocol).toBe("saml");

    const back = await send("owner", "PUT", "/v1/identity-provider", {
      ...okta,
      clientSecret: "returning-secret-value",
      protocol: "oidc",
    });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ issuer: "https://idp.example.com", protocol: "oidc" });
    expect(back.body.connectionId).not.toBe(saml.body.connectionId);
    expect(Object.keys(back.body).toSorted()).toEqual(OIDC_RESPONSE_KEYS);
  });
});
