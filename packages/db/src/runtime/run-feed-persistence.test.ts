import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { DEFAULT_TABLE_NAMES } from "../client-types.ts";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { decodePlatformRecord, withCanonicalRecordKeys } from "../records/index.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import { makeRunFeedPersistence, runFeedPartition } from "./run-feed-persistence.ts";

const id = (suffix: string) =>
  Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G5${suffix.padStart(3, "0")}`);
const ORG_ID = id("1");
const PROJECT_ID = id("2");
const ENVIRONMENT_ID = id("3");
const OTHER_ENVIRONMENT_ID = id("4");
const DEPLOYMENT_A = id("5");
const DEPLOYMENT_B = id("6");
const BINDING_ID = id("7");
const RELEASE_A = id("8");
const RELEASE_B = id("9");
const THREAD_A = id("10");
const THREAD_B = id("11");
const scope = { environmentId: ENVIRONMENT_ID, organizationId: ORG_ID, projectId: PROJECT_ID };

type RunStatus = "completed" | "queued" | "running";

interface RunInput {
  readonly createdAt: string;
  readonly environmentId?: typeof ENVIRONMENT_ID;
  readonly executionSlot?: number;
  readonly owner:
    | { readonly agentDeploymentId: typeof DEPLOYMENT_A; readonly agentReleaseId: typeof RELEASE_A }
    | { readonly executionBindingId: typeof BINDING_ID; readonly executionPurpose: "evaluation" };
  readonly runId: typeof ENVIRONMENT_ID;
  readonly status: RunStatus;
  readonly threadId: typeof THREAD_A;
  readonly version?: number;
}

function runRecord(input: RunInput) {
  return Effect.runPromise(
    decodePlatformRecord(
      withCanonicalRecordKeys({
        data: {
          ...input.owner,
          attempt: 0,
          captureMode: "metadata-only",
          createdAt: input.createdAt,
          environmentId: input.environmentId ?? ENVIRONMENT_ID,
          executor: "platform",
          ...(input.executionSlot === undefined ? {} : { executionSlot: input.executionSlot }),
          id: input.runId,
          idempotencyKey: `run/${input.runId}`,
          organizationId: ORG_ID,
          priority: 1,
          projectId: PROJECT_ID,
          redactionPolicyVersion: 1,
          schemaVersion: 1,
          spanId: "0123456789abcdef",
          status: input.status,
          threadId: input.threadId,
          traceId: "0123456789abcdef0123456789abcdef",
          trigger: "api",
          updatedAt: input.createdAt,
          version: input.version ?? 1,
        },
        itemType: "run",
      }),
    ),
  );
}

const customer = (agentDeploymentId: typeof DEPLOYMENT_A, agentReleaseId: typeof RELEASE_A) => ({
  agentDeploymentId,
  agentReleaseId,
});
const evaluation = { executionBindingId: BINDING_ID, executionPurpose: "evaluation" as const };

const RUNS: readonly RunInput[] = [
  {
    createdAt: "2026-09-01T00:00:01.000Z",
    owner: customer(DEPLOYMENT_A, RELEASE_A),
    runId: id("21"),
    status: "completed",
    threadId: THREAD_A,
  },
  {
    createdAt: "2026-09-01T00:00:02.000Z",
    owner: customer(DEPLOYMENT_B, RELEASE_B),
    executionSlot: 0,
    runId: id("22"),
    status: "running",
    threadId: THREAD_B,
  },
  {
    createdAt: "2026-09-01T00:00:03.000Z",
    owner: evaluation,
    runId: id("23"),
    status: "completed",
    threadId: THREAD_B,
  },
  {
    createdAt: "2026-09-01T00:00:04.000Z",
    owner: customer(DEPLOYMENT_A, RELEASE_A),
    runId: id("24"),
    status: "queued",
    threadId: THREAD_A,
  },
  {
    createdAt: "2026-09-01T00:00:05.000Z",
    environmentId: OTHER_ENVIRONMENT_ID,
    owner: customer(DEPLOYMENT_A, RELEASE_A),
    runId: id("25"),
    status: "completed",
    threadId: THREAD_A,
  },
];

async function seededFeed() {
  const dynamo = fakeDynamoDocumentClient();
  const database = makeDynamoDatabase(dynamo.client);
  dynamo.put(
    DEFAULT_TABLE_NAMES.control,
    withCanonicalRecordKeys({
      data: {
        createdAt: "2026-09-01T00:00:00.000Z",
        id: ORG_ID,
        name: "Feed Organization",
        slug: "feed-organization",
        status: "active",
        updatedAt: "2026-09-01T00:00:00.000Z",
        version: 1,
      },
      itemType: "organization",
    }),
  );
  for (const input of RUNS) {
    const run = await runRecord(input);
    if (input.status === "running") await database.transactWrite([{ kind: "put", record: run }]);
    else await database.putRecord(run);
  }
  return { database, dynamo, feed: makeRunFeedPersistence(database) };
}

const runIds = (page: { readonly runs: readonly { readonly data: { readonly id: string } }[] }) =>
  page.runs.map((run) => run.data.id);

describe("environment run feed", () => {
  test("mirrors run filters onto locators without changing locator keys", async () => {
    const { database, dynamo } = await seededFeed();
    const locatorKey = {
      pk: key("ORG", ORG_ID, "ENV", ENVIRONMENT_ID),
      sk: key("RUN-LOCATOR", id("24")),
    };
    const feedKeys = {
      gsi2pk: runFeedPartition(ENVIRONMENT_ID),
      gsi2sk: key("RUN-LOCATOR", "all", "2026-09-01T00:00:04.000Z", id("24")),
    };
    expect(dynamo.get(DEFAULT_TABLE_NAMES.control, locatorKey)).toMatchObject({
      data: {
        agentReleaseId: RELEASE_A,
        executionPurpose: "customer",
        runStatus: "queued",
        threadId: THREAD_A,
      },
      ...feedKeys,
    });

    await database.transactWrite([
      {
        kind: "put",
        previousRecord: await runRecord(RUNS[3]!),
        record: await runRecord({ ...RUNS[3]!, executionSlot: 1, status: "running", version: 2 }),
      },
    ]);
    expect(dynamo.get(DEFAULT_TABLE_NAMES.control, locatorKey)).toMatchObject({
      data: { runStatus: "running" },
      ...feedKeys,
    });
  });

  test("keeps locators without run mirrors decodable but out of the feed", async () => {
    const { database, dynamo, feed } = await seededFeed();
    const locatorKey = {
      pk: key("ORG", ORG_ID, "ENV", ENVIRONMENT_ID),
      sk: key("RUN-LOCATOR", id("21")),
    };
    const stored = dynamo.get(DEFAULT_TABLE_NAMES.control, locatorKey) as {
      readonly data: Readonly<Record<string, unknown>>;
    };
    const {
      agentReleaseId: _release,
      executionPurpose: _purpose,
      runStatus: _status,
      threadId: _thread,
      ...earlierData
    } = stored.data;
    dynamo.put(DEFAULT_TABLE_NAMES.control, { ...stored, data: earlierData });

    const decoded = await database.getRecord("control", locatorKey);
    expect(decoded).toBeDefined();
    expect(decoded).toMatchObject({ data: { id: id("21") }, itemType: "run-locator" });
    expect(runIds(await feed.listEnvironmentRuns(scope, { filters: {}, limit: 100 }))).toEqual([
      id("24"),
      id("23"),
      id("22"),
    ]);
  });

  test("lists runs across deployments and bindings newest first with continuation keys", async () => {
    const { feed } = await seededFeed();

    const first = await feed.listEnvironmentRuns(scope, { filters: {}, limit: 3 });
    expect(runIds(first)).toEqual([id("24"), id("23"), id("22")]);
    expect(first.lastEvaluatedKey).toBeDefined();

    const second = await feed.listEnvironmentRuns(scope, {
      exclusiveStartKey: first.lastEvaluatedKey,
      filters: {},
      limit: 3,
    });
    expect(runIds(second)).toEqual([id("21")]);
    expect(second.lastEvaluatedKey).toBeUndefined();
  });

  test("filters by status, release, purpose, thread, and an inclusive creation range", async () => {
    const { feed } = await seededFeed();
    const list = async (filters: Parameters<typeof feed.listEnvironmentRuns>[1]["filters"]) =>
      runIds(await feed.listEnvironmentRuns(scope, { filters, limit: 100 }));

    expect(await list({ status: "completed" })).toEqual([id("23"), id("21")]);
    expect(await list({ agentReleaseId: RELEASE_A })).toEqual([id("24"), id("21")]);
    expect(await list({ executionPurpose: "evaluation" })).toEqual([id("23")]);
    expect(await list({ executionPurpose: "customer" })).toEqual([id("24"), id("22"), id("21")]);
    expect(await list({ threadId: THREAD_B })).toEqual([id("23"), id("22")]);
    expect(
      await list({
        createdAfter: "2026-09-01T00:00:02.000Z",
        createdBefore: "2026-09-01T00:00:03.000Z",
      }),
    ).toEqual([id("23"), id("22")]);
    expect(await list({ createdAfter: "2026-09-01T00:00:04.000Z" })).toEqual([id("24")]);
  });

  test("never returns runs of another environment or tenant", async () => {
    const { feed } = await seededFeed();

    const environment = await feed.listEnvironmentRuns(scope, { filters: {}, limit: 100 });
    expect(runIds(environment)).not.toContain(id("25"));
    expect(
      runIds(
        await feed.listEnvironmentRuns(
          { ...scope, environmentId: OTHER_ENVIRONMENT_ID },
          { filters: {}, limit: 100 },
        ),
      ),
    ).toEqual([id("25")]);
    expect(
      runIds(
        await feed.listEnvironmentRuns(
          { ...scope, projectId: id("12") },
          { filters: {}, limit: 100 },
        ),
      ),
    ).toEqual([]);
  });

  test("drops index candidates whose canonical run no longer matches the filters", async () => {
    const { dynamo, feed } = await seededFeed();
    const locatorKey = {
      pk: key("ORG", ORG_ID, "ENV", ENVIRONMENT_ID),
      sk: key("RUN-LOCATOR", id("21")),
    };
    const locator = dynamo.get(DEFAULT_TABLE_NAMES.control, locatorKey) as {
      readonly data: Readonly<Record<string, unknown>>;
    };
    // A lagging index entry: the locator still claims a status the canonical run has left.
    dynamo.put(
      DEFAULT_TABLE_NAMES.control,
      withCanonicalRecordKeys({
        data: { ...locator.data, runStatus: "running" },
        itemType: "run-locator",
      } as Parameters<typeof withCanonicalRecordKeys>[0]),
    );

    expect(
      runIds(await feed.listEnvironmentRuns(scope, { filters: { status: "running" }, limit: 100 })),
    ).toEqual([id("22")]);
  });
});
