import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import { DEFAULT_TABLE_NAMES, type DynamoDatabaseService } from "../client-types.ts";
import { makeDynamoDatabase, tableNamesFromEnvironment } from "../dynamo-database.ts";
import { createWithClaims } from "../identity-federation/operations.ts";
import { makeIdGenerator, type Ulid } from "../ids.ts";
import { makePlatformPrincipalDirectory } from "../system/principal-directory.ts";
import { signedUpPerson } from "../tenancy/organization-creation-test-support.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import { makePrincipalSecurityRepository } from "./principal-security.ts";
import { refreshRecords, sessionRecords } from "./record-builders.ts";

const endpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;
const SIGNED_UP_EPOCH = 3;
const NOW = new Date("2026-10-18T12:00:00.000Z");

const stores: readonly {
  readonly name: string;
  readonly open: () => DynamoDatabaseService;
  readonly skip: boolean;
}[] = [
  {
    name: "fake DynamoDB",
    open: () => makeDynamoDatabase(fakeDynamoDocumentClient().client, DEFAULT_TABLE_NAMES),
    skip: false,
  },
  {
    name: "local DynamoDB",
    open: () =>
      makeDynamoDatabase(
        DynamoDBDocumentClient.from(
          new DynamoDBClient({
            ...(endpoint ? { endpoint } : {}),
            region: process.env.AWS_REGION ?? "us-east-1",
          }),
          { marshallOptions: { removeUndefinedValues: true } },
        ),
        tableNamesFromEnvironment(),
      ),
    skip: !endpoint,
  },
];

for (const store of stores) {
  describe.skipIf(store.skip)(`principal security on ${store.name}`, () => {
    const ids = makeIdGenerator();

    async function signedIn() {
      const database = store.open();
      const principalId = ids.generate();
      await database.transactWrite(
        signedUpPerson(principalId).flatMap((record) =>
          record.itemType === "principal"
            ? createWithClaims(record, record.data.createdAt)
            : [{ kind: "put" as const, record }],
        ),
      );
      const session = sessionRecords({
        authentication: { method: "password" },
        authenticationTime: "2026-10-18T11:00:00.000Z",
        createdAt: "2026-10-18T11:00:00.000Z",
        expiresAt: "2026-11-18T11:00:00.000Z",
        id: ids.generate(),
        idleExpiresAt: "2026-10-19T11:00:00.000Z",
        principalId,
        sessionEpoch: SIGNED_UP_EPOCH,
        tokenHash: `session-${principalId}`,
      });
      const refresh = refreshRecords({
        audience: "https://api.example.test",
        authenticationTime: "2026-10-18T11:00:00.000Z",
        clientId: "deployments-cli",
        createdAt: "2026-10-18T11:00:00.000Z",
        expiresAt: "2026-11-18T11:00:00.000Z",
        familyId: ids.generate(),
        principalId,
        scopes: ["openid"],
        sessionEpoch: SIGNED_UP_EPOCH,
        tokenHash: `refresh-${principalId}`,
        tokenId: ids.generate(),
      });
      await database.transactWrite(
        [...Object.values(session), refresh.family, refresh.token].map((record) => ({
          kind: "put" as const,
          record,
        })),
      );
      return {
        events: makePlatformPrincipalDirectory(database),
        principalId,
        security: makePrincipalSecurityRepository({ database, now: () => NOW }),
      };
    }

    test("revoking sessions ends them, names the operator and reason, and a repeat ends them again", async () => {
      const { events, principalId, security } = await signedIn();
      const operator = ids.generate();
      const revoke = { actorPrincipalId: operator, principalId, reason: "Account takeover report" };

      const before = await security.describe(principalId);
      const outcomes = [
        await security.revokeSessions(revoke),
        await security.revokeSessions(revoke),
      ];
      const after = await security.describe(principalId);
      const recorded = await events.securityEvents(principalId);

      expect([before?.sessions, after?.sessions]).toEqual([
        { browser: 1, capped: false, refreshFamilies: 1 },
        { browser: 0, capped: false, refreshFamilies: 0 },
      ]);
      expect(outcomes).toEqual([
        { principalId, sessionsEndedAt: NOW.toISOString() },
        { principalId, sessionsEndedAt: NOW.toISOString() },
      ]);
      expect(
        recorded.items.map((event) => [event.eventType, event.actor?.id, event.payload]),
      ).toEqual([
        ["identity.sessions-invalidated", operator, { reason: "Account takeover report" }],
        ["identity.sessions-invalidated", operator, { reason: "Account takeover report" }],
      ]);
    });

    test("describes MFA and the verified email without returning secrets", async () => {
      const { principalId, security } = await signedIn();

      expect(await security.describe(principalId)).toEqual({
        emailVerifiedAt: "2026-10-01T00:00:00.000Z",
        mfa: { state: "none" },
        sessions: { browser: 1, capped: false, refreshFamilies: 1 },
      });
      expect(await security.describe(ids.generate() as Ulid)).toBeUndefined();
    });

    test("refuses to revoke for someone who is not a person", async () => {
      const { security } = await signedIn();
      expect(
        security.revokeSessions({
          actorPrincipalId: ids.generate(),
          principalId: ids.generate(),
          reason: "Typo",
        }),
      ).rejects.toMatchObject({ code: "principal_not_found", kind: "not-found" });
    });
  });
}
