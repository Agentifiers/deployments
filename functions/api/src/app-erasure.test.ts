import {
  AppSlug,
  Ulid,
  makeAppPersistence,
  makeDynamoDatabase,
  makeIdGenerator,
  tableNamesFromEnvironment,
  withCanonicalRecordKeys,
  type AppRecord,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { eraseAgentBuiltApp } from "./app-erasure.ts";

const ulid = Schema.decodeUnknownSync(Ulid);
const ORGANIZATION = ulid("01ARZ3NDEKTSV4RRFFQ69G5FE0");
const START = "2026-10-09T00:00:00.000Z";
const MINUTE = 60_000;

async function provisioningApp() {
  let clock = Date.parse(START);
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  fake.put(
    tables.control,
    withCanonicalRecordKeys({
      data: {
        createdAt: START,
        id: ORGANIZATION,
        name: "Acme",
        slug: "acme",
        status: "active",
        updatedAt: START,
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
  const apps = makeAppPersistence({
    database: makeDynamoDatabase(fake.client, tables),
    generateId: makeIdGenerator().generate,
    now: () => new Date(clock),
  });
  const app = await apps.createApp({
    actor: { type: "system" },
    agentDefinitionId: ulid("01ARZ3NDEKTSV4RRFFQ69G5FE1"),
    clusterKey: "default",
    createdBy: { principalId: null, runId: ulid("01ARZ3NDEKTSV4RRFFQ69G5FE2") },
    databaseLayout: 1,
    environmentId: ulid("01ARZ3NDEKTSV4RRFFQ69G5FE3"),
    name: "Payroll",
    organizationId: ORGANIZATION,
    projectId: ulid("01ARZ3NDEKTSV4RRFFQ69G5FE4"),
    slug: Schema.decodeUnknownSync(AppSlug)("payroll"),
    workspaceId: ulid("01ARZ3NDEKTSV4RRFFQ69G5FE5"),
  });
  const erasures: string[] = [];
  const appsDatabase = {
    erase: async (erased: AppRecord) => {
      erasures.push(erased.data.id);
    },
  };
  return {
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    app,
    apps,
    appsDatabase,
    erasures,
  };
}

describe("eraseAgentBuiltApp", () => {
  test("refuses an app whose provision may still be running and erases nothing", async () => {
    const { app, apps, appsDatabase, erasures } = await provisioningApp();

    const refused = await eraseAgentBuiltApp(
      { apps, appsDatabase },
      { actor: { type: "system" }, app },
    ).catch((error: unknown) => error);

    expect(refused).toMatchObject({
      message: `App ${app.data.id} may still be provisioning; erasure becomes possible after 2026-10-09T00:10:00.000Z.`,
      reason: "still-provisioning",
    });
    expect(erasures).toEqual([]);
    expect(await apps.getApp(app.data.id)).toEqual(app);
  });

  test("erases a provisioning app once no provision can still be running", async () => {
    const { advance, app, apps, appsDatabase, erasures } = await provisioningApp();
    advance(11 * MINUTE);

    const erasing = await eraseAgentBuiltApp(
      { apps, appsDatabase },
      { actor: { type: "system" }, app },
    );

    expect(erasing.data.lifecycle).toEqual({
      requestedAt: "2026-10-09T00:11:00.000Z",
      state: "erasing",
    });
    expect(erasures).toEqual([app.data.id]);
    expect(await apps.getApp(app.data.id)).toBeUndefined();
  });
});
