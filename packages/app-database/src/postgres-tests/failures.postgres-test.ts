import { afterAll, beforeAll, expect, test } from "bun:test";
import { Schema } from "effect";
import { createAppDatabaseControl } from "../app-database.ts";
import { appDatabaseNames, type AppId, type AppSlug } from "../names.ts";
import { ExportId } from "../protocol.ts";
import {
  asSuperuser,
  createTestControl,
  eraseInput,
  errorOf,
  newAppId,
  newSlug,
  prepareCluster,
  testConnections,
  type TestControl,
} from "./harness.ts";

const EXPORT_ID = Schema.decodeUnknownSync(ExportId)("01J9Z3NDEKTSV4RRFFQ69G5FAW");

let harness: TestControl;
const apps: Array<{ appId: AppId; slug: AppSlug }> = [];

beforeAll(async () => {
  await prepareCluster();
  harness = createTestControl();
});

afterAll(async () => {
  for (const app of apps) await harness.control.erase(eraseInput(app));
  await harness.control.close();
});

test("a slug directory or object store failure reaches the caller unchanged", async () => {
  const exported = { appId: newAppId(), slug: newSlug() };
  const provisioned = { appId: newAppId(), slug: newSlug() };
  apps.push(exported, provisioned);
  await harness.control.provision(exported);
  await harness.control.migrate({
    appId: exported.appId,
    description: "orders",
    idempotencyKey: "orders",
    sql: "CREATE TABLE orders (id int); INSERT INTO orders VALUES (1);",
  });
  const control = createAppDatabaseControl({
    connections: testConnections,
    objectStore: {
      deleteObjects: harness.objects.deleteObjects,
      listObjects: harness.objects.listObjects,
      putObject: async () => {
        throw new Error("AccessDenied: s3:PutObject");
      },
    },
    slugDirectory: {
      put: async () => {
        throw new Error("AccessDeniedException: cloudfront-keyvaluestore:PutKey");
      },
      remove: harness.slugs.remove,
    },
  });

  const outcomes = {
    export: await errorOf(
      control.exportTables({ appId: exported.appId, bucket: "apps", exportId: EXPORT_ID }),
    ),
    provision: await errorOf(control.provision(provisioned)),
  };
  await control.close();

  expect(outcomes).toEqual({
    export: {
      code: undefined,
      message: "AccessDenied: s3:PutObject",
      name: "Error",
      statement: undefined,
    },
    provision: {
      code: undefined,
      message: "AccessDeniedException: cloudfront-keyvaluestore:PutKey",
      name: "Error",
      statement: undefined,
    },
  });
});

test("an export of a table that forces row level security fails as a postgres_error", async () => {
  const app = { appId: newAppId(), slug: newSlug() };
  apps.push(app);
  await harness.control.provision(app);
  await harness.control.migrate({
    appId: app.appId,
    description: "orders",
    idempotencyKey: "orders",
    sql: "CREATE TABLE orders (id int); INSERT INTO orders VALUES (1);",
  });
  await asSuperuser(appDatabaseNames(app.appId).database, (client) =>
    client.query(
      "ALTER TABLE orders ENABLE ROW LEVEL SECURITY; ALTER TABLE orders FORCE ROW LEVEL SECURITY; CREATE POLICY hide_all ON orders USING (false);",
    ),
  );

  const failure = await errorOf(
    harness.control.exportTables({ appId: app.appId, bucket: "apps", exportId: EXPORT_ID }),
  );

  expect({ failure, objects: [...harness.objects.entries.keys()] }).toEqual({
    failure: {
      code: "postgres_error",
      message: [
        'query would be affected by row-level security policy for table "orders"',
        "HINT: To disable the policy for the table's owner, use ALTER TABLE NO FORCE ROW LEVEL SECURITY.",
      ].join("\n"),
      name: "AppDatabaseError",
      statement: "COPY public.orders TO STDOUT WITH (FORMAT csv, HEADER true)",
    },
    objects: [],
  });
});
