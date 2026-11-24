import { afterAll, beforeAll, expect, test } from "bun:test";
import type { ApiCallInput } from "../api-call.ts";
import { createAppApiGateway, type AppApiGateway } from "../app-database.ts";
import type { AppDatabaseLimits } from "../limits.ts";
import { appDatabaseNames, type AppId, type AppSlug } from "../names.ts";
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
import { stallingProxy, type StallingProxy } from "./stalling-proxy.ts";

const SCHEMA = `
CREATE TABLE signups (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, email text NOT NULL);
CREATE FUNCTION visitor.ping() RETURNS int LANGUAGE sql STABLE BEGIN ATOMIC SELECT 1; END;
CREATE FUNCTION visitor.sign_up(p_email text) RETURNS int LANGUAGE sql VOLATILE
  BEGIN ATOMIC INSERT INTO signups (email) VALUES (p_email) RETURNING 1; END;
CREATE TABLE keys (k int UNIQUE DEFERRABLE INITIALLY DEFERRED);
CREATE FUNCTION visitor.add_key_twice() RETURNS int LANGUAGE sql VOLATILE
  BEGIN ATOMIC INSERT INTO keys (k) VALUES (1), (1) RETURNING 1; END;
CREATE FUNCTION visitor.slow_sign_up(p_email text, p_seconds float8) RETURNS int LANGUAGE sql VOLATILE
  BEGIN ATOMIC
    SELECT 1 FROM pg_sleep(p_seconds);
    INSERT INTO signups (email) VALUES (p_email) RETURNING id;
  END;
CREATE FUNCTION public.ignore_cancels() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.email LIKE 'stuck%' THEN
    LOOP
      BEGIN PERFORM pg_sleep(0.05); EXCEPTION WHEN query_canceled THEN NULL; END;
    END LOOP;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER signups_ignore_cancels BEFORE INSERT ON signups
  FOR EACH ROW EXECUTE FUNCTION ignore_cancels();
`;

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
  const { database } = appDatabaseNames(appId);
  await asSuperuser("postgres", (client) =>
    client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [
      database,
    ]),
  );
  await harness.control.erase(eraseInput({ appId, slug }));
  await harness.control.close();
});

function viaProxy(limits: Partial<AppDatabaseLimits>) {
  proxy.stall = () => undefined;
  return createAppApiGateway({ connections: { ...testConnections, port: proxy.port }, limits });
}

function visitorCall(
  gateway: AppApiGateway,
  input: Pick<ApiCallInput, "args" | "deadlineMs" | "functionName">,
) {
  return gateway.callApiFunction({ ...input, appId, appIsPublic: true, role: "visitor" });
}

async function signups() {
  const { database } = appDatabaseNames(appId);
  return asSuperuser(database, async (client) =>
    (await client.query<{ email: string }>("SELECT email FROM signups ORDER BY id")).rows.map(
      (row) => row.email,
    ),
  );
}

async function clearSignups() {
  await asSuperuser(appDatabaseNames(appId).database, (client) => client.query("TRUNCATE signups"));
}

async function elapsed<T>(work: Promise<T>) {
  const started = performance.now();
  const value = await work;
  return { ms: performance.now() - started, value };
}

test("a call's deadline ends its database work, so a deadline_exceeded call wrote nothing", async () => {
  await clearSignups();
  const gateway = createAppApiGateway({ connections: testConnections });
  try {
    const late = await elapsed(
      errorOf(
        visitorCall(gateway, {
          args: { p_email: "late@example.com", p_seconds: 3 },
          deadlineMs: 2_000,
          functionName: "slow_sign_up",
        }),
      ),
    );
    // Real time: the database's own statement timeout and commit are the subject.
    await Bun.sleep(1_500);

    expect({
      answeredWithinDeadline: late.ms >= 1_900 && late.ms < 2_900,
      error: late.value,
      written: await signups(),
    }).toEqual({
      answeredWithinDeadline: true,
      error: {
        code: "deadline_exceeded",
        message: expect.stringMatching(/^The statement exceeded its 19\d\d ms deadline\.$/u),
        name: "AppDatabaseError",
        statement: "visitor.slow_sign_up",
      },
      written: [],
    });
  } finally {
    await gateway.close();
  }
});

test("calls on connections whose server stopped answering settle after the deadline, grace and terminator timeout", async () => {
  const gateway = viaProxy({ graceMs: 500 });
  try {
    const warm = await Promise.all(
      ["a", "b"].map((name) =>
        visitorCall(gateway, {
          args: { p_email: `${name}@example.com`, p_seconds: 0.2 },
          deadlineMs: 2_000,
          functionName: "slow_sign_up",
        }),
      ),
    );
    proxy.stall = () => "dropped";
    const hung = await elapsed(
      Promise.race([
        Promise.all(
          [1, 2].map(() =>
            errorOf(visitorCall(gateway, { args: {}, deadlineMs: 2_000, functionName: "ping" })),
          ),
        ),
        Bun.sleep(30_000).then(() => "still pending after 30 s"),
      ]),
    );

    expect({
      settledWithinBound: hung.ms < 2_000 + 500 + 10_000 + 1_500,
      codes: Array.isArray(hung.value) ? hung.value.map((error) => error.code) : hung.value,
      warm: warm.map((result) => result.rows.length),
    }).toEqual({
      codes: ["deadline_exceeded", "deadline_exceeded"],
      settledWithinBound: true,
      warm: [1, 1],
    });
  } finally {
    await gateway.close();
  }
}, 60_000);

test("a call whose COMMIT answer never arrives answers outcome_unknown, because the write may have committed", async () => {
  await clearSignups();
  const gateway = viaProxy({ graceMs: 500 });
  try {
    await visitorCall(gateway, {
      args: { p_email: "warm@example.com" },
      deadlineMs: 1_000,
      functionName: "sign_up",
    });
    proxy.stall = (sent) => (sent.includes("COMMIT") ? "dropped" : undefined);
    const lost = await elapsed(
      errorOf(
        visitorCall(gateway, {
          args: { p_email: "once@example.com" },
          deadlineMs: 1_000,
          functionName: "sign_up",
        }),
      ),
    );

    expect({
      error: lost.value,
      settledWithinBound: lost.ms < 1_000 + 500 + 500 + 500 + 1_000,
      written: await signups(),
    }).toEqual({
      error: {
        code: "outcome_unknown",
        message:
          "The app database did not confirm COMMIT, so whether the call's changes were saved is unknown.",
        name: "AppDatabaseError",
        statement: undefined,
      },
      settledWithinBound: true,
      written: ["warm@example.com", "once@example.com"],
    });
  } finally {
    await gateway.close();
  }
}, 30_000);

test("a connection lost after COMMIT was sent, before the deadline, answers outcome_unknown rather than a retryable error", async () => {
  await clearSignups();
  const gateway = viaProxy({ graceMs: 500 });
  try {
    await visitorCall(gateway, {
      args: { p_email: "warm@example.com" },
      deadlineMs: 10_000,
      functionName: "sign_up",
    });
    proxy.stall = (sent) => (sent.includes("COMMIT") ? { cutMs: 300 } : undefined);
    const lost = await elapsed(
      errorOf(
        visitorCall(gateway, {
          args: { p_email: "once@example.com" },
          deadlineMs: 10_000,
          functionName: "sign_up",
        }),
      ),
    );

    expect({
      code: lost.value.code,
      settledBeforeDeadline: lost.ms < 5_000,
      written: await signups(),
    }).toEqual({
      code: "outcome_unknown",
      settledBeforeDeadline: true,
      written: ["warm@example.com", "once@example.com"],
    });
  } finally {
    await gateway.close();
  }
}, 30_000);

test("a server ERROR answering COMMIT keeps its rolled-back mapping", async () => {
  const gateway = createAppApiGateway({ connections: testConnections });
  try {
    const refused = await errorOf(
      visitorCall(gateway, { args: {}, deadlineMs: 2_000, functionName: "add_key_twice" }),
    );
    const keys = await asSuperuser(
      appDatabaseNames(appId).database,
      async (client) => (await client.query("SELECT k FROM keys")).rows,
    );

    expect({ keys, refused: { code: refused.code, message: refused.message } }).toEqual({
      keys: [],
      refused: {
        code: "postgres_error",
        message:
          'duplicate key value violates unique constraint "keys_k_key"\nDETAIL: Key (k)=(1) already exists.',
      },
    });
  } finally {
    await gateway.close();
  }
});

test("a COMMIT answer that arrives after the terminator returned still settles the call as committed", async () => {
  await clearSignups();
  const gateway = viaProxy({ graceMs: 1_000 });
  try {
    await visitorCall(gateway, {
      args: { p_email: "warm@example.com" },
      deadlineMs: 1_000,
      functionName: "sign_up",
    });
    proxy.stall = (sent) => (sent.includes("COMMIT") ? { heldMs: 2_500 } : undefined);
    const committed = await visitorCall(gateway, {
      args: { p_email: "once@example.com" },
      deadlineMs: 1_000,
      functionName: "sign_up",
    }).then(
      (result) => result.rows,
      (error: unknown) => error,
    );
    await Bun.sleep(200);

    expect({ committed, written: await signups() }).toEqual({
      committed: [1],
      written: ["warm@example.com", "once@example.com"],
    });
  } finally {
    await gateway.close();
  }
}, 30_000);

test("a backend that ignores cancels ends once its client is gone, even when the terminator cannot log in", async () => {
  const { roles } = appDatabaseNames(appId);
  await asSuperuser("postgres", (client) =>
    client.query(`ALTER ROLE ${roles.visitor} CONNECTION LIMIT 1`),
  );
  const gateway = createAppApiGateway({ connections: testConnections });
  try {
    const stuck = await errorOf(
      visitorCall(gateway, {
        args: { p_email: "stuck@example.com" },
        deadlineMs: 1_000,
        functionName: "sign_up",
      }),
    );
    await Bun.sleep(2_500);
    const next = await visitorCall(gateway, { args: {}, deadlineMs: 1_000, functionName: "ping" })
      .then((result) => result.rows)
      .catch((error: unknown) => (error instanceof Error ? error.message : error));

    expect({ next, stuck: stuck.code }).toEqual({ next: [1], stuck: "deadline_exceeded" });
  } finally {
    await gateway.close();
    await harness.control.provision({ appId, slug });
  }
}, 30_000);
