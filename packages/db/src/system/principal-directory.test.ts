import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { DEFAULT_TABLE_NAMES, type TableNames } from "../client-types.ts";
import { makeDynamoDatabase, tableNamesFromEnvironment } from "../dynamo-database.ts";
import { createWithClaims } from "../identity-federation/operations.ts";
import { makeIdGenerator, type Ulid } from "../ids.ts";
import { makeIdentitySecurityEventRecord } from "../identity/security-events.ts";
import { OrganizationMemberRecord, OrganizationRecord } from "../records/tenancy.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { signedUpPerson } from "../tenancy/organization-creation-test-support.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import {
  PRINCIPAL_MEMBERSHIP_READ_LIMIT,
  makePlatformPrincipalDirectory,
} from "./principal-directory.ts";

const endpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;
const AT = "2026-10-01T00:00:00.000Z";

const stores: readonly {
  readonly name: string;
  readonly open: () => { readonly client: DynamoDBDocumentClient; readonly tables: TableNames };
  readonly skip: boolean;
}[] = [
  {
    name: "fake DynamoDB",
    open: () => ({ client: fakeDynamoDocumentClient().client, tables: DEFAULT_TABLE_NAMES }),
    skip: false,
  },
  {
    name: "local DynamoDB",
    open: () => ({
      client: DynamoDBDocumentClient.from(
        new DynamoDBClient({
          ...(endpoint ? { endpoint } : {}),
          region: process.env.AWS_REGION ?? "us-east-1",
        }),
        { marshallOptions: { removeUndefinedValues: true } },
      ),
      tables: tableNamesFromEnvironment(),
    }),
    skip: !endpoint,
  },
];

function organization(id: Ulid, name: string) {
  return Schema.decodeUnknownSync(OrganizationRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: AT,
        id,
        name,
        slug: name.toLowerCase(),
        status: "active",
        updatedAt: AT,
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
}

function member(organizationId: Ulid, principalId: Ulid, role: "member" | "owner") {
  return Schema.decodeUnknownSync(OrganizationMemberRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: AT,
        joinedAt: AT,
        organizationId,
        principalId,
        role,
        status: "active",
        updatedAt: AT,
        version: 1,
      },
      itemType: "organization-member" as const,
    }),
  );
}

for (const store of stores) {
  describe.skipIf(store.skip)(`platform principal directory on ${store.name}`, () => {
    const ids = makeIdGenerator();

    async function person() {
      const { client, tables } = store.open();
      const database = makeDynamoDatabase(client, tables);
      const principalId = ids.generate();
      const acme = ids.generate();
      const globex = ids.generate();
      await database.transactWrite(
        signedUpPerson(principalId).flatMap((record) =>
          record.itemType === "principal"
            ? createWithClaims(record, AT)
            : [{ kind: "put" as const, record }],
        ),
      );
      for (const item of [
        organization(acme, "Acme"),
        organization(globex, "Globex"),
        member(acme, principalId, "owner"),
        member(globex, principalId, "member"),
      ]) {
        await client.send(new PutCommand({ Item: item, TableName: tables.control }));
      }
      return {
        acme,
        client,
        directory: makePlatformPrincipalDirectory(database),
        globex,
        principalId,
        tables,
      };
    }

    test("finds a person by exact email and lists the organizations they belong to", async () => {
      const { acme, directory, globex, principalId } = await person();
      const email = `${principalId.toLowerCase()}@example.test`;

      const found = await directory.findByEmail(email);
      const missing = await directory.findByEmail(`x${email}`);
      const detail = await directory.get(principalId);

      expect([found?.id, missing]).toEqual([principalId, undefined]);
      expect(detail?.membershipsCapped).toBe(false);
      expect(
        detail?.memberships
          .map((membership) => [
            membership.organization?.name,
            membership.organizationId,
            membership.role,
          ])
          .toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))),
      ).toEqual([
        ["Acme", acme, "owner"],
        ["Globex", globex, "member"],
      ]);
      expect(await directory.get(ids.generate())).toBeUndefined();
    });

    test("returns at most the membership bound and says when more exist", async () => {
      const { client, directory, principalId, tables } = await person();
      for (let index = 0; index < PRINCIPAL_MEMBERSHIP_READ_LIMIT - 1; index += 1) {
        await client.send(
          new PutCommand({
            Item: member(ids.generate(), principalId, "member"),
            TableName: tables.control,
          }),
        );
      }

      const detail = await directory.get(principalId);

      expect([detail?.memberships.length, detail?.membershipsCapped]).toEqual([
        PRINCIPAL_MEMBERSHIP_READ_LIMIT,
        true,
      ]);
    });

    test("pages a person's security events newest first", async () => {
      const { client, directory, principalId, tables } = await person();
      const events = [
        "identity.password-changed",
        "identity.mfa-enabled",
        "identity.session-revoked",
      ].map((eventType, index) =>
        makeIdentitySecurityEventRecord({
          aggregateId: ids.generate(),
          aggregateType: "test-aggregate",
          aggregateVersion: 1,
          eventId: ids.generate(),
          eventType,
          occurredAt: `2026-10-0${index + 2}T00:00:00.000Z`,
          payload: { clientId: "deployments-cli" },
          principalId,
        }),
      );
      for (const item of events) {
        await client.send(new PutCommand({ Item: item, TableName: tables.events }));
      }

      const first = await directory.securityEvents(principalId, { limit: 2 });
      const second = await directory.securityEvents(principalId, {
        cursor: first.nextCursor,
        limit: 2,
      });

      expect([...first.items, ...second.items].map((event) => event.eventType)).toEqual([
        "identity.session-revoked",
        "identity.mfa-enabled",
        "identity.password-changed",
      ]);
      expect(second.nextCursor).toBeUndefined();
      expect(
        directory.securityEvents(ids.generate(), { cursor: first.nextCursor }),
      ).rejects.toMatchObject({ code: "invalid_cursor" });
    });
  });
}
