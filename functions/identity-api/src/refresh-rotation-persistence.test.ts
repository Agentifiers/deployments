import { describe, expect, test } from "bun:test";
import {
  makeDynamoDatabase,
  makeIdentityRepository,
  oauthClientRecord,
  principalRecord,
  refreshRecords,
  securityStateRecord,
  tableForItemType,
  tableNamesFromEnvironment,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { sha256 } from "@deployments-ai/identity";
import { makeOAuthApplication } from "./oauth-application.ts";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as Ulid;
const FAMILY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as Ulid;
const TOKEN_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as Ulid;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const createdAt = "2026-07-28T00:00:00.000Z";

/** Exercises refresh rotation through the production DynamoDB adapter, which validates every put. */
function refreshFixture() {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  const rawRefreshToken = "refresh-secret";
  const { family, token } = refreshRecords({
    audience: "https://api.deployments.ai",
    authenticationTime: createdAt,
    clientId: "deployments-cli",
    createdAt,
    expiresAt: "2026-08-28T00:00:00.000Z",
    familyId: FAMILY_ID,
    principalId: PRINCIPAL_ID,
    scopes: ["offline_access", "openid"],
    sessionEpoch: 0,
    tokenHash: sha256(rawRefreshToken),
    tokenId: TOKEN_ID,
  });
  for (const record of [
    family,
    token,
    principalRecord({ createdAt, id: PRINCIPAL_ID, primaryEmail: "user@example.com" }),
    securityStateRecord({
      createdAt,
      credentialVersion: 1,
      emailVerifiedAt: createdAt,
      principalId: PRINCIPAL_ID,
      sessionEpoch: 0,
      version: 1,
    }),
    oauthClientRecord({
      allowedScopes: ["offline_access", "openid"],
      clientId: "deployments-cli",
      createdAt,
      grantTypes: ["authorization_code", "refresh_token"],
      name: "Deployments CLI",
      redirectUris: ["http://127.0.0.1/callback"],
      requiredScopes: [],
      tokenEndpointAuthMethod: "none",
      type: "public",
      version: 1,
    }),
  ] as PlatformRecord[]) {
    // Default table names equal the logical table names.
    fake.put(tableForItemType(record.itemType), record);
  }
  let sequence = 0;
  let clock = Date.parse("2026-07-28T01:00:00.000Z");
  const repository = makeIdentityRepository(makeDynamoDatabase(fake.client, tables));
  const application = makeOAuthApplication(
    {
      encryptEmailPayload: async () => ({
        algorithm: "AES-256-GCM",
        authenticationTag: "tag",
        ciphertext: "ciphertext",
        encryptedDataKey: "encrypted-key",
        encryptionContextHash: "context-hash",
        iv: "iv",
        schemaVersion: 1,
      }),
      generateId: () => {
        sequence += 1;
        return `01ARZ3NDEKTSV4RRFFQ69G6${CROCKFORD[Math.floor(sequence / 32) % 32]}${CROCKFORD[sequence % 32]}0` as Ulid;
      },
      now: () => new Date(clock),
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
  const records = (itemType: PlatformRecord["itemType"]) =>
    fake
      .items(tableForItemType(itemType))
      .filter((item) => item.itemType === itemType)
      .map((item) => item.data as Readonly<Record<string, unknown>>);
  return {
    advanceSeconds: (seconds: number) => {
      clock += seconds * 1_000;
    },
    application,
    familyStatus: async () => (await repository.refreshFamilyForId(FAMILY_ID))?.data.status,
    liveRefreshTokenHashes: () =>
      records("oauth-refresh-token")
        .filter((token) => token.status === "active")
        .map((token) => token.tokenHash),
    rawRefreshToken,
    refresh: (refreshToken: string) =>
      application.exchangeRefreshToken({ clientId: "deployments-cli", refreshToken }),
    refreshReuseEmails: () =>
      records("identity-email-delivery").filter(
        (delivery) => delivery.purpose === "suspicious-refresh-reuse",
      ).length,
    repository,
  };
}

describe("refresh rotation persistence", () => {
  test("rotates through the production adapter and keeps the chain usable", async () => {
    const { application, rawRefreshToken, repository } = refreshFixture();
    const first = await application.exchangeRefreshToken({
      clientId: "deployments-cli",
      refreshToken: rawRefreshToken,
    });
    const second = await application.exchangeRefreshToken({
      clientId: "deployments-cli",
      refreshToken: first.refresh_token,
    });
    expect(second.refresh_token).not.toBe(first.refresh_token);

    const original = await repository.refreshTokenForHash(sha256(rawRefreshToken));
    expect(original?.data).toMatchObject({
      replacementTokenHash: sha256(first.refresh_token),
      status: "rotated",
    });
  });

  test("treats a retry of a lost rotation within 60 seconds as the same exchange", async () => {
    const fixture = refreshFixture();
    const lost = await fixture.refresh(fixture.rawRefreshToken);
    fixture.advanceSeconds(5);
    const retried = await fixture.refresh(fixture.rawRefreshToken);
    fixture.advanceSeconds(30);
    const retriedAgain = await fixture.refresh(fixture.rawRefreshToken);

    expect(
      new Set([lost.refresh_token, retried.refresh_token, retriedAgain.refresh_token]).size,
    ).toBe(3);
    expect(fixture.liveRefreshTokenHashes()).toEqual([sha256(retriedAgain.refresh_token)]);
    expect(await fixture.familyStatus()).toBe("active");
    expect(fixture.refreshReuseEmails()).toBe(0);
    fixture.advanceSeconds(600);
    expect(fixture.refresh(retriedAgain.refresh_token)).resolves.toMatchObject({
      token_type: "Bearer",
    });
  });

  test("still treats a retry more than 60 seconds after the rotation as reuse", async () => {
    const fixture = refreshFixture();
    const rotated = await fixture.refresh(fixture.rawRefreshToken);
    fixture.advanceSeconds(61);

    expect(fixture.refresh(fixture.rawRefreshToken)).rejects.toThrow(
      "Refresh token reuse detected.",
    );
    expect(await fixture.familyStatus()).toBe("compromised");
    expect(fixture.refreshReuseEmails()).toBe(1);
    expect(fixture.refresh(rotated.refresh_token)).rejects.toThrow(
      "Refresh token is no longer active.",
    );
  });

  test("treats a token two rotations old as reuse inside the retry window", async () => {
    const fixture = refreshFixture();
    const first = await fixture.refresh(fixture.rawRefreshToken);
    fixture.advanceSeconds(1);
    await fixture.refresh(first.refresh_token);
    fixture.advanceSeconds(1);

    expect(fixture.refresh(fixture.rawRefreshToken)).rejects.toThrow(
      "Refresh token reuse detected.",
    );
    expect(await fixture.familyStatus()).toBe("compromised");
    expect(fixture.refreshReuseEmails()).toBe(1);
  });

  test("treats reuse after the client used the retried successor as theft", async () => {
    const fixture = refreshFixture();
    await fixture.refresh(fixture.rawRefreshToken);
    fixture.advanceSeconds(1);
    await fixture.refresh(fixture.rawRefreshToken);
    fixture.advanceSeconds(1);
    const retried = await fixture.refresh(fixture.rawRefreshToken);
    fixture.advanceSeconds(1);
    const used = await fixture.refresh(retried.refresh_token);
    fixture.advanceSeconds(1);

    expect(fixture.refresh(fixture.rawRefreshToken)).rejects.toThrow(
      "Refresh token reuse detected.",
    );
    expect(await fixture.familyStatus()).toBe("compromised");
    expect(fixture.refreshReuseEmails()).toBe(1);
    expect(fixture.refresh(used.refresh_token)).rejects.toThrow(
      "Refresh token is no longer active.",
    );
  });

  test("measures the retry window from the first rotation however often it is retried", async () => {
    const fixture = refreshFixture();
    await fixture.refresh(fixture.rawRefreshToken);
    fixture.advanceSeconds(30);
    await fixture.refresh(fixture.rawRefreshToken);
    fixture.advanceSeconds(31);

    expect(fixture.refresh(fixture.rawRefreshToken)).rejects.toThrow(
      "Refresh token reuse detected.",
    );
    expect(await fixture.familyStatus()).toBe("compromised");
    expect(fixture.refreshReuseEmails()).toBe(1);
  });

  test("lets exactly one of two concurrent retries mint the live successor", async () => {
    const fixture = refreshFixture();
    await fixture.refresh(fixture.rawRefreshToken);
    fixture.advanceSeconds(5);

    const outcomes = await Promise.allSettled([
      fixture.refresh(fixture.rawRefreshToken),
      fixture.refresh(fixture.rawRefreshToken),
    ]);
    const [live, ...otherLive] = fixture.liveRefreshTokenHashes();

    expect(otherLive).toEqual([]);
    expect(
      outcomes
        .map((outcome) =>
          outcome.status === "fulfilled"
            ? sha256(outcome.value.refresh_token) === live
            : outcome.reason.message,
        )
        .toSorted((left, right) => String(left).localeCompare(String(right))),
    ).toEqual(["Refresh could not be completed because identity state kept changing.", true]);
    expect(await fixture.familyStatus()).toBe("active");
    expect(fixture.refreshReuseEmails()).toBe(0);
  });
});

describe("refresh revocation persistence", () => {
  test("revokes the family through the production adapter so its tokens stop working", async () => {
    const { application, rawRefreshToken, repository } = refreshFixture();
    await application.revokeRefreshToken({
      clientId: "deployments-cli",
      refreshToken: rawRefreshToken,
    });
    const family = await repository.refreshFamilyForId(FAMILY_ID);
    expect(family?.data.status).toBe("revoked");
    expect(
      application.exchangeRefreshToken({
        clientId: "deployments-cli",
        refreshToken: rawRefreshToken,
      }),
    ).rejects.toThrow("Refresh token is no longer active.");
  });
});
