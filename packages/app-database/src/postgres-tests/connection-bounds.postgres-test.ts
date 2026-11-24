import { afterAll, beforeAll, expect, test } from "bun:test";
import { createAppApiGateway, type AppApiGateway } from "../app-database.ts";
import type { AppDatabaseLimits } from "../limits.ts";
import type { AppId, AppSlug } from "../names.ts";
import {
  createTestControl,
  eraseInput,
  errorOf,
  newAppId,
  newSlug,
  prepareCluster,
  testConnections,
  type TestControl,
} from "./harness.ts";
import { stallingProxy, type StallingProxy } from "./stalling-proxy.ts";

const SCHEMA = `
CREATE FUNCTION visitor.hold(p_seconds float8) RETURNS int LANGUAGE sql VOLATILE
  BEGIN ATOMIC SELECT 1 FROM pg_sleep(p_seconds); END;
CREATE FUNCTION visitor.ping() RETURNS int LANGUAGE sql STABLE BEGIN ATOMIC SELECT 1; END;
`;
const PENDING = "still pending after 10 s";

let harness: TestControl;
let appId: AppId;
let slug: AppSlug;
let proxy: StallingProxy;

beforeAll(async () => {
  await prepareCluster();
  harness = createTestControl();
  appId = newAppId();
  slug = newSlug();
  await harness.control.provision({ appId, slug });
  await harness.control.migrate({
    appId,
    description: "schema",
    idempotencyKey: "schema",
    sql: SCHEMA,
  });
  proxy = await stallingProxy();
});

afterAll(async () => {
  await proxy.close();
  await harness.control.erase(eraseInput({ appId, slug }));
  await harness.control.close();
});

function viaProxy(limits: Partial<AppDatabaseLimits> = {}, resumeWaitMs = 0) {
  proxy.stall = () => undefined;
  return createAppApiGateway({
    connections: { ...testConnections, port: proxy.port, resumeWaitMs },
    limits,
  });
}

function visitorCall(
  gateway: AppApiGateway,
  functionName: string,
  args: Record<string, number>,
  deadlineMs: number,
) {
  return gateway.callApiFunction({
    appId,
    appIsPublic: true,
    args,
    deadlineMs,
    functionName,
    role: "visitor",
  });
}

async function timed<T>(work: Promise<T>) {
  const started = performance.now();
  const value = await Promise.race([work, Bun.sleep(10_000).then(() => PENDING)]);
  return { ms: Math.round(performance.now() - started), value };
}

test("a visitor waiting on a full visitor pool gives up by its deadline, and the pool recovers", async () => {
  const gateway = createAppApiGateway({ connections: testConnections });
  try {
    const holders = [1, 2].map(() => visitorCall(gateway, "hold", { p_seconds: 3 }, 4_000));
    await Bun.sleep(300);
    const waiter = await timed(errorOf(visitorCall(gateway, "ping", {}, 1_000)));
    await Promise.all(holders);
    const after = await Promise.all(
      [1, 2].map(() => visitorCall(gateway, "ping", {}, 1_000).then((result) => result.rows)),
    );

    expect({
      after,
      byDeadline: waiter.ms >= 950 && waiter.ms < 1_500,
      waiter: waiter.value,
    }).toEqual({
      after: [[1], [1]],
      byDeadline: true,
      waiter: {
        code: "connections_exhausted",
        message: expect.stringMatching(
          /^The app's 2 connections for this role stayed busy for (9\d\d|1000) ms\.$/u,
        ),
        name: "AppDatabaseError",
        statement: undefined,
      },
    });
  } finally {
    await gateway.close();
  }
}, 30_000);

test("a new connection the server is slow to accept is given up by the call's deadline and closed when it arrives", async () => {
  const gateway = viaProxy();
  proxy.stall = (sent) => (sent === "" ? { heldMs: 3_000 } : undefined);
  const refused = await timed(errorOf(visitorCall(gateway, "ping", {}, 1_000)));
  const closed = await timed(gateway.close().then(() => "closed"));

  expect({
    byDeadline: refused.ms >= 950 && refused.ms < 1_500,
    closed: closed.value,
    refused: refused.value,
  }).toEqual({
    byDeadline: true,
    closed: "closed",
    refused: {
      code: "database_unavailable",
      message: expect.stringMatching(
        /^The app database did not accept a connection within (9\d\d|1000) ms\.$/u,
      ),
      name: "AppDatabaseError",
      statement: undefined,
    },
  });
}, 30_000);

test("a login the resuming server holds past the call's deadline is waited out, and the call still gets its deadline", async () => {
  const holdsLogins = (sent: string) => (sent === "" ? { heldMs: 3_000 } : undefined);
  const impatient = viaProxy();
  proxy.stall = holdsLogins;
  const refused = await errorOf(visitorCall(impatient, "hold", { p_seconds: 1 }, 2_000));
  await impatient.close();
  const patient = viaProxy({}, 30_000);
  try {
    proxy.stall = holdsLogins;
    const answered = await timed(
      visitorCall(patient, "hold", { p_seconds: 1 }, 2_000).then((result) => result.rows),
    );

    expect({ answered: answered.value, afterTheResume: answered.ms >= 4_000, refused }).toEqual({
      afterTheResume: true,
      answered: [1],
      refused: {
        code: "database_unavailable",
        message: expect.stringMatching(
          /^The app database did not accept a connection within (19\d\d|2000) ms\.$/u,
        ),
        name: "AppDatabaseError",
        statement: undefined,
      },
    });
  } finally {
    await patient.close();
  }
}, 30_000);

test("a new connection whose server does not answer pg_backend_pid() is given up after the grace period", async () => {
  const gateway = viaProxy({ graceMs: 500 });
  try {
    proxy.stall = (sent) => (sent.includes("pg_backend_pid") ? "dropped" : undefined);
    const refused = await timed(errorOf(visitorCall(gateway, "ping", {}, 1_000)));

    expect({ refused: refused.value, withinGrace: refused.ms < 1_000 }).toEqual({
      refused: {
        code: "database_unavailable",
        message: "The app database did not answer pg_backend_pid() within 500 ms.",
        name: "AppDatabaseError",
        statement: undefined,
      },
      withinGrace: true,
    });
  } finally {
    await gateway.close();
  }
});

test("a finished call whose server does not answer DISCARD ALL returns after the grace period", async () => {
  const gateway = viaProxy({ graceMs: 500 });
  try {
    await visitorCall(gateway, "ping", {}, 1_000);
    proxy.stall = (sent) => (sent.includes("DISCARD ALL") ? "dropped" : undefined);
    const answered = await timed(visitorCall(gateway, "ping", {}, 1_000).then((r) => r.rows));

    expect({ answered: answered.value, withinGrace: answered.ms < 1_000 }).toEqual({
      answered: [1],
      withinGrace: true,
    });
  } finally {
    await gateway.close();
  }
});

test("a terminator whose server does not answer pg_terminate_backend is given up after the grace period", async () => {
  const gateway = viaProxy({ graceMs: 500 });
  try {
    await visitorCall(gateway, "ping", {}, 1_000);
    proxy.stall = (sent) =>
      sent.includes("BEGIN") || sent.includes("pg_terminate_backend") ? "dropped" : undefined;
    const ended = await timed(errorOf(visitorCall(gateway, "ping", {}, 1_000)));

    const code = typeof ended.value === "string" ? ended.value : ended.value.code;
    expect({ code, withinBound: ended.ms < 2_500 }).toEqual({
      code: "deadline_exceeded",
      withinBound: true,
    });
  } finally {
    await gateway.close();
  }
});
