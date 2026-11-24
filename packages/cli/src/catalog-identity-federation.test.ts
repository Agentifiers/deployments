import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { identityFederationCommandCatalog } from "./catalog-identity-federation.ts";
import { buildRequest } from "./command-runtime.ts";
import type { ResolvedCliContext } from "./types.ts";

const directories: string[] = [];
const context: ResolvedCliContext = {
  apiKey: "token",
  apiUrl: "https://api.example.com",
  mock: false,
  organizationId: "organization-1",
  profileName: "default",
};
const set = identityFederationCommandCatalog["identity-provider"]!.actions.set!;
const JIT = '{"kind":"enabled","role":"member"}';

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function bodyOf(args: Readonly<Record<string, string>>, env: NodeJS.ProcessEnv = {}) {
  return (await buildRequest(set, args, context, env)).body;
}

describe("identity-provider set", () => {
  test("an invocation without --protocol sends the OIDC body it always sent", async () => {
    const request = await buildRequest(
      set,
      {
        "client-id": "console-client",
        "client-secret-env": "SSO_SECRET",
        "display-name": "Example SSO",
        issuer: "https://login.example.com",
        jit: JIT,
      },
      context,
      { SSO_SECRET: "s3cret" },
    );
    expect(request).toMatchObject({ method: "PUT", path: "/v1/identity-provider" });
    expect(request.body).toEqual({
      clientId: "console-client",
      clientSecret: "s3cret",
      displayName: "Example SSO",
      issuer: "https://login.example.com",
      jit: { kind: "enabled", role: "member" },
    });
  });

  test("--protocol saml with a metadata URL nests it and passes the SAML settings", async () => {
    expect(
      await bodyOf({
        "display-name": "Okta",
        "email-attribute": "mail",
        jit: '{"kind":"disabled"}',
        "metadata-url": "https://example.okta.com/app/abc/sso/saml/metadata",
        protocol: "saml",
        "unsolicited-sign-in": "enabled",
      }),
    ).toEqual({
      displayName: "Okta",
      emailAttribute: "mail",
      jit: { kind: "disabled" },
      metadata: { url: "https://example.okta.com/app/abc/sso/saml/metadata" },
      protocol: "saml",
      unsolicitedSignIn: "enabled",
    });
  });

  test("--metadata-file sends the file's XML verbatim as the metadata document", async () => {
    const directory = await mkdtemp(join(tmpdir(), "identity-provider-cli-"));
    directories.push(directory);
    const path = join(directory, "entra.xml");
    await writeFile(path, '<EntityDescriptor entityID="https://sts.windows.net/t/"/>\n');
    expect(
      await bodyOf({ "display-name": "Entra", jit: JIT, "metadata-file": path, protocol: "saml" }),
    ).toEqual({
      displayName: "Entra",
      jit: { kind: "enabled", role: "member" },
      metadata: { document: '<EntityDescriptor entityID="https://sts.windows.net/t/"/>\n' },
      protocol: "saml",
    });
  });

  test("each protocol refuses the other protocol's flags and needs its own", async () => {
    const saml = { "display-name": "Okta", jit: JIT, protocol: "saml" };
    const oidc = {
      "client-id": "client",
      "display-name": "SSO",
      issuer: "https://a.test",
      jit: JIT,
    };
    expect(
      bodyOf({ ...saml, "client-secret": "s3cret", "metadata-url": "https://a.test/m" }),
    ).rejects.toThrow(
      "--protocol saml does not take --client-secret, --client-secret-env, or --client-secret-file.",
    );
    expect(bodyOf({ ...saml, issuer: "https://a.test" })).rejects.toThrow(
      "--protocol saml does not take --issuer.",
    );
    expect(bodyOf(saml)).rejects.toThrow(
      "A SAML provider needs --metadata-url or --metadata-file.",
    );
    expect(
      bodyOf({ ...saml, "metadata-file": "/tmp/metadata.xml", "metadata-url": "https://a.test/m" }),
    ).rejects.toThrow("Choose either --metadata-file or --metadata-url.");
    expect(bodyOf({ ...oidc, "unsolicited-sign-in": "enabled" })).rejects.toThrow(
      "--protocol oidc does not take --unsolicited-sign-in.",
    );
    expect(bodyOf({ "display-name": "SSO", issuer: "https://a.test", jit: JIT })).rejects.toThrow(
      "An OIDC provider needs --issuer and --client-id.",
    );
    expect(bodyOf({ ...oidc, protocol: "ldap" })).rejects.toThrow(
      "--protocol must be oidc or saml.",
    );
    expect(await bodyOf({ ...oidc, protocol: "oidc" })).toEqual({
      clientId: "client",
      displayName: "SSO",
      issuer: "https://a.test",
      jit: { kind: "enabled", role: "member" },
    });
  });
});
