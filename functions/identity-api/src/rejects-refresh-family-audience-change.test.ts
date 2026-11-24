import { oauthClientRecord, refreshRecords, type IdentityRepository } from "@deployments-ai/db";
import { expect, test } from "bun:test";
import { sha256 } from "@deployments-ai/identity";
import { makeOAuthApplication } from "./oauth-application.ts";

test("a refresh family cannot cross its durably bound resource audience", async () => {
  const createdAt = "2026-07-28T00:00:00.000Z";
  const client = oauthClientRecord({
    allowedScopes: ["offline_access"],
    clientId: "deployments-cli",
    createdAt,
    grantTypes: ["refresh_token"],
    name: "Deployments CLI",
    redirectUris: ["http://127.0.0.1/callback"],
    requiredScopes: [],
    tokenEndpointAuthMethod: "none",
    type: "public",
    version: 1,
  });
  const { family, token } = refreshRecords({
    audience: "https://old-api.deployments.ai",
    authenticationTime: createdAt,
    clientId: "deployments-cli",
    createdAt,
    expiresAt: "2026-08-28T00:00:00.000Z",
    familyId: "01ARZ3NDEKTSV4RRFFQ69G5FAX" as never,
    principalId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never,
    scopes: ["offline_access"],
    sessionEpoch: 0,
    tokenHash: sha256("refresh-secret"),
    tokenId: "01ARZ3NDEKTSV4RRFFQ69G5FAY" as never,
  });
  const repository = {
    clientForId: () => Promise.resolve(client),
    refreshFamilyForId: () => Promise.resolve(family),
    refreshTokenForHash: () => Promise.resolve(token),
  } as unknown as IdentityRepository;
  const application = makeOAuthApplication(
    {
      encryptEmailPayload: async () => {
        throw new Error("Email delivery is not expected.");
      },
      generateId: () => "01ARZ3NDEKTSV4RRFFQ69G5FAZ" as never,
      repository,
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
    application.exchangeRefreshToken({
      clientId: "deployments-cli",
      refreshToken: "refresh-secret",
    }),
  ).rejects.toThrow("Refresh token is invalid.");
});
