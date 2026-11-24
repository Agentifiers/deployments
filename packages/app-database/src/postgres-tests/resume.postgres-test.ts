import { afterAll, beforeAll, expect, test } from "bun:test";
import { Schema } from "effect";
import net from "node:net";
import type { ConnectionSettings } from "../connection.ts";
import type { AppDatabaseLimits } from "../limits.ts";
import { appDatabaseNames, type AppId, type AppSlug } from "../names.ts";
import { ExportId } from "../protocol.ts";
import {
  asRole,
  createTestControl,
  eraseInput,
  errorOf,
  newAppId,
  newSlug,
  prepareCluster,
  testConnections,
  type TestControl,
} from "./harness.ts";

let dropped = 0;
const proxy = net.createServer((socket) => {
  if (dropped > 0) {
    dropped -= 1;
    socket.destroy();
    return;
  }
  const upstream = net.connect(testConnections.port, testConnections.host);
  socket.on("error", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
  socket.pipe(upstream).pipe(socket);
});

let harness: TestControl;
const controls: TestControl[] = [];
const apps: Array<{ appId: AppId; slug: AppSlug }> = [];

function throughProxy(resumeWaitMs: number, limits: Partial<AppDatabaseLimits> = {}): TestControl {
  const address = proxy.address();
  if (address === null || typeof address === "string")
    throw new Error("The proxy is not listening.");
  const connections: ConnectionSettings = {
    ...testConnections,
    host: "127.0.0.1",
    port: address.port,
    resumeWaitMs,
  };
  const created = createTestControl(limits, connections);
  controls.push(created);
  return created;
}

beforeAll(async () => {
  await prepareCluster();
  harness = createTestControl();
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
});

afterAll(async () => {
  for (const { control } of controls) await control.close();
  for (const app of apps) await harness.control.erase(eraseInput(app));
  await harness.control.close();
  proxy.close();
});

test("provision and query wait out logins that fail while the database resumes", async () => {
  const app = { appId: newAppId(), slug: newSlug() };
  apps.push(app);
  const impatient = throughProxy(0);
  const patient = throughProxy(60_000);

  dropped = 2;
  const refusedProvision = await errorOf(impatient.control.provision(app));
  dropped = 2;
  const provisioned = await patient.control.provision(app);
  await patient.control.migrate({
    appId: app.appId,
    description: "orders",
    idempotencyKey: "orders",
    sql: "CREATE TABLE orders (id int); INSERT INTO orders VALUES (7);",
  });
  dropped = 2;
  const refusedQuery = await errorOf(
    impatient.control.query({ appId: app.appId, maxRows: 10, sql: "SELECT id FROM orders" }),
  );
  dropped = 2;
  const queried = await patient.control.query({
    appId: app.appId,
    maxRows: 10,
    sql: "SELECT id FROM orders",
  });

  const unavailable = {
    code: "database_unavailable",
    message: "The app database did not answer: Connection terminated unexpectedly",
    name: "AppDatabaseError",
    statement: undefined,
  };
  expect({
    provisioned: provisioned.appId,
    queried: queried.rows,
    refusedProvision,
    refusedQuery,
  }).toEqual({
    provisioned: app.appId,
    queried: [["7"]],
    refusedProvision: unavailable,
    refusedQuery: unavailable,
  });
});

test("an export spends its deadline from before it waits out a resume", async () => {
  const app = { appId: newAppId(), slug: newSlug() };
  apps.push(app);
  await harness.control.provision(app);
  await harness.control.migrate({
    appId: app.appId,
    description: "orders",
    idempotencyKey: "orders",
    sql: "CREATE TABLE orders (id int);",
  });
  const exportDeadlineMs = 2_000;
  const twoRefusedLoginsWaitMs = 500 + 1_000;
  const patient = throughProxy(60_000, { exportDeadlineMs, graceMs: 750 });
  const names = appDatabaseNames(app.appId);

  const failure = await asRole(names.database, names.roles.owner, async (client) => {
    await client.query("BEGIN");
    await client.query("LOCK TABLE orders IN ACCESS EXCLUSIVE MODE");
    dropped = 2;
    const exported = await errorOf(
      patient.control.exportTables({
        appId: app.appId,
        bucket: "apps",
        exportId: Schema.decodeUnknownSync(ExportId)("01J9Z3NDEKTSV4RRFFQ69G5FAW"),
      }),
    );
    await client.query("ROLLBACK");
    return exported;
  });

  const statementDeadlineMs = Number(/exceeded its (\d+) ms deadline/u.exec(failure.message)?.[1]);
  expect({
    code: failure.code,
    deadlineCountsTheWait: statementDeadlineMs <= exportDeadlineMs - twoRefusedLoginsWaitMs,
  }).toEqual({ code: "deadline_exceeded", deadlineCountsTheWait: true });
});
