import { DeleteCommand, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import {
  ArtifactRecord,
  DEFAULT_TABLE_NAMES,
  EnvironmentRecord,
  key,
  makeArtifactIndexPersistence,
  makeDynamoDatabase,
  OrganizationRecord,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { migrateArtifactCreationIndex } from "./artifact-creation-index-migration.ts";

const ORGANIZATION_ID = "01J9ZQ5Y5V7Q8R3X2K4M6N8P0A";
const PROJECT_ID = "01J9ZQ5Y5V7Q8R3X2K4M6N8P0B";
const ENVIRONMENT_ID = "01J9ZQ5Y5V7Q8R3X2K4M6N8P0C";
const OLD_ARTIFACT_ID = "01J9ZQ5Y5V7Q8R3X2K4M6N8P0D";
const NEW_ARTIFACT_ID = "01J9ZQ5Y5V7Q8R3X2K4M6N8P0E";
const AT = "2026-09-01T00:00:00.000Z";
const COMPLETION_MARKER = {
  pk: "GLOBAL#deploy-migration",
  sk: "DEPLOY-MIGRATION#artifact-creation-index",
};

type Item = Readonly<Record<string, unknown>>;

function artifact(artifactId: string, createdAt: string, updatedAt: string) {
  return Schema.decodeUnknownSync(ArtifactRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt,
        environmentId: ENVIRONMENT_ID,
        id: artifactId,
        name: artifactId,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        retentionExpiresAt: "2027-01-01T00:00:00.000Z",
        status: "available",
        storage: {
          bucket: "artifact-bucket",
          byteSize: 1,
          contentType: "text/plain",
          key: `artifacts/${artifactId}`,
          sha256: "a".repeat(64),
        },
        type: "report",
        updatedAt,
        version: 3,
        visibility: "organization",
      },
      itemType: "artifact",
      ttl: Math.floor(Date.parse("2027-01-01T00:00:00.000Z") / 1_000),
    }),
  );
}

async function installation() {
  const tables = { client: fakeDynamoDocumentClient().client, tableNames: DEFAULT_TABLE_NAMES };
  const send = tables.client.send.bind(tables.client);
  const { control, execution } = tables.tableNames;
  await send(new DeleteCommand({ Key: COMPLETION_MARKER, TableName: control }));
  for (const item of [
    Schema.decodeUnknownSync(OrganizationRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: AT,
          id: ORGANIZATION_ID,
          name: "Artifacts",
          slug: "artifacts",
          status: "active",
          updatedAt: AT,
          version: 1,
        },
        itemType: "organization" as const,
      }),
    ),
    Schema.decodeUnknownSync(EnvironmentRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: AT,
          id: ENVIRONMENT_ID,
          kind: "production",
          name: "Production",
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          slug: "production",
          status: "active",
          updatedAt: AT,
          version: 1,
        },
        itemType: "environment" as const,
      }),
    ),
  ]) {
    await send(new PutCommand({ Item: item, TableName: control }));
  }
  // Stored before the creation index: its environment key sorts by status and update time.
  const old = artifact(OLD_ARTIFACT_ID, "2026-09-02T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
  const legacy: Item = {
    ...old,
    gsi2sk: key("ARTIFACT", "available", old.data.updatedAt, OLD_ARTIFACT_ID),
  };
  const current = artifact(NEW_ARTIFACT_ID, "2026-09-03T00:00:00.000Z", "2026-09-03T00:00:00.000Z");
  for (const item of [legacy, current]) {
    await send(new PutCommand({ Item: item, TableName: execution }));
  }
  const stored = async (item: Item) =>
    (await send(new GetCommand({ Key: { pk: item.pk, sk: item.sk }, TableName: execution }))).Item;
  return { current, legacy, stored, tables };
}

describe("artifact creation index migration", () => {
  test("re-keys artifacts stored with the status-ordered environment key and nothing else", async () => {
    const { current, legacy, stored, tables } = await installation();
    const listed = () =>
      makeArtifactIndexPersistence(makeDynamoDatabase(tables.client, tables.tableNames))
        .environmentPage(ENVIRONMENT_ID, {}, {})
        .then((page) => page.artifacts.map((record) => String(record.data.id)));
    expect(await listed()).toEqual([OLD_ARTIFACT_ID, NEW_ARTIFACT_ID]);

    const result = await migrateArtifactCreationIndex(tables);

    expect(result).toEqual({ changed: 0, environments: 1, fixed: 1, kind: "swept", read: 2 });
    expect(await stored(legacy)).toEqual({
      ...legacy,
      gsi2sk: `ARTIFACT#2026-09-02T00%3A00%3A00.000Z#${OLD_ARTIFACT_ID}`,
    });
    expect(await stored(current)).toEqual(current);
    expect(await listed()).toEqual([NEW_ARTIFACT_ID, OLD_ARTIFACT_ID]);
    expect(await migrateArtifactCreationIndex(tables)).toEqual({ kind: "already-complete" });
  });

  test("leaves an artifact that changed during the sweep for the next deploy", async () => {
    const { legacy, stored, tables } = await installation();
    const send = tables.client.send.bind(tables.client);
    const changed = { ...legacy, data: { ...(legacy.data as Item), name: "renamed" } };
    tables.client.send = (async (command: object) => {
      if (command instanceof PutCommand && command.input.Item?.sk === legacy.sk) {
        await send(new PutCommand({ Item: changed, TableName: tables.tableNames.execution }));
      }
      return send(command as never);
    }) as typeof tables.client.send;

    const result = await migrateArtifactCreationIndex(tables);

    expect(result).toMatchObject({ changed: 1, fixed: 0 });
    expect(await stored(legacy)).toEqual(changed);
    tables.client.send = send as typeof tables.client.send;
    expect(await migrateArtifactCreationIndex(tables)).toMatchObject({ kind: "swept" });
  });
});
