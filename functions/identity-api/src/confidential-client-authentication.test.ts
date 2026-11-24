import { describe, expect, test } from "bun:test";
import { oauthClientRecord, type IdentityRepository } from "@deployments-ai/db";
import { sha256 } from "@deployments-ai/identity";
import { makeOAuthApplication } from "./oauth-application.ts";

const REDIRECT_URI = "https://apps.deployments.ai/_platform/auth/callback";

describe("confidential client authentication", () => {
  test("a code and its PKCE verifier without the client secret are refused before the code is read", async () => {
    const codeReads: string[] = [];
    const client = oauthClientRecord({
      allowedScopes: ["openid"],
      clientId: "deployments-apps",
      clientSecretHash: sha256("client-secret"),
      createdAt: "2026-07-28T00:00:00.000Z",
      grantTypes: ["authorization_code"],
      name: "Deployments apps",
      redirectUris: [REDIRECT_URI],
      requiredScopes: ["openid"],
      tokenEndpointAuthMethod: "client_secret_basic",
      type: "confidential",
      version: 1,
    });
    const application = makeOAuthApplication(
      {
        encryptEmailPayload: async () => {
          throw new Error("not used");
        },
        generateId: () => "01ARZ3NDEKTSV4RRFFQ69G5FAY" as never,
        repository: {
          authorizationCodeForHash: (codeHash: string) => {
            codeReads.push(codeHash);
            return Promise.resolve(undefined);
          },
          clientForId: () => Promise.resolve(client),
        } as unknown as IdentityRepository,
        signer: { jwks: async () => ({ keys: [] }), sign: async () => "signed" },
      },
      {
        accessTokenSeconds: 300,
        authorizationCodeSeconds: 60,
        authorizationRequestSeconds: 300,
        idTokenSeconds: 300,
        issuer: "https://auth.deployments.ai",
        refreshTokenSeconds: 2_592_000,
        resourceAudience: "https://api.deployments.ai",
      },
    );

    expect(
      application.exchangeAuthorizationCode({
        clientId: "deployments-apps",
        code: "authorization-code",
        codeVerifier: "a".repeat(43),
        redirectUri: REDIRECT_URI,
      }),
    ).rejects.toThrow("Client authentication failed.");
    expect(codeReads).toEqual([]);
  });
});
