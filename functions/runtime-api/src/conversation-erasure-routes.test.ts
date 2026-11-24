import { describe, expect, test } from "bun:test";
import { endUserKeyDeriver } from "@deployments-ai/conversations";
import {
  ApiCredentialRecord,
  ServiceAccountRecord,
  makeConversationErasureStore,
  makeDynamoDatabase,
  makeUniqueClaimRecord,
  tableForItemType,
  uniqueClaimRequirements,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { Schema } from "effect";
import { createRuntimeApiHandler } from "./runtime-handler.ts";
import {
  deployment,
  deploymentId,
  environmentId,
  ids,
  now,
  organizationId,
  projectId,
  release,
  serviceAccountId,
} from "./runtime-lifecycle.fixture.ts";
import { credentialHash, type RuntimeApiDependencies } from "./runtime-support.ts";

const SUBJECT_SECRET = "end-user-subject-test-key-0123456789abcdef";
const otherEnvironmentId = ids[28]!;
const localId = (index: number) =>
  `01ARZ3NDEKTSV4RRFFQ69J${String(index).padStart(4, "0")}` as Ulid;
const KEY = "dpl_test_erasure_key";
const FOREIGN_KEY = "dpl_test_erasure_foreign_key";
const WRITE_ONLY_KEY = "dpl_test_erasure_write_only_key";
const TABLES = { control: "control", events: "events", execution: "execution", usage: "usage" };

function environmentRecord(environment: Ulid): PlatformRecord {
  const seeded: unknown = withCanonicalRecordKeys({
    data: { id: environment, organizationId, projectId, status: "active" as const },
    itemType: "environment" as const,
  });
  return seeded as PlatformRecord;
}

function apiKey(secret: string, environment: Ulid, scopes: readonly string[], index: number) {
  const common = {
    createdAt: now.toISOString(),
    environmentId: environment,
    organizationId,
    projectId,
    updatedAt: now.toISOString(),
    version: 0,
  };
  const accountId =
    environment === environmentId && index === 0 ? serviceAccountId : localId(10 + index);
  const account = Schema.decodeUnknownSync(ServiceAccountRecord)(
    withCanonicalRecordKeys({
      data: {
        ...common,
        id: accountId,
        name: `Erasure ${index}`,
        scopes,
        status: "active" as const,
      },
      itemType: "service-account" as const,
    }),
  );
  const credential = Schema.decodeUnknownSync(ApiCredentialRecord)(
    withCanonicalRecordKeys({
      data: {
        ...common,
        credentialHash: credentialHash(secret),
        id: localId(20 + index),
        keyPrefix: "dpl_test",
        name: `Erasure credential ${index}`,
        scopes,
        serviceAccountId: accountId,
        status: "active" as const,
      },
      itemType: "api-credential" as const,
    }),
  );
  return [
    account,
    credential,
    makeUniqueClaimRecord(uniqueClaimRequirements(credential)[0]!, now.toISOString()),
  ] as PlatformRecord[];
}

function fixture() {
  const fake = fakeDynamoDocumentClient();
  const erasureScopes = ["runs:read", "runs:write", "runs:erase", "end-users:erase"];
  for (const record of [
    withCanonicalRecordKeys({
      data: {
        createdAt: now.toISOString(),
        id: organizationId,
        name: "Erasure",
        slug: "erasure",
        status: "active" as const,
        updatedAt: now.toISOString(),
        version: 1,
      },
      itemType: "organization" as const,
    }) as PlatformRecord,
    environmentRecord(environmentId),
    environmentRecord(otherEnvironmentId),
    deployment(),
    release(),
    ...apiKey(KEY, environmentId, erasureScopes, 0),
    ...apiKey(FOREIGN_KEY, otherEnvironmentId, erasureScopes, 1),
    ...apiKey(WRITE_ONLY_KEY, environmentId, ["runs:read", "runs:write"], 2),
  ]) {
    fake.put(tableForItemType(record.itemType), record);
    for (const requirement of uniqueClaimRequirements(record)) {
      fake.put("control", makeUniqueClaimRecord(requirement, now.toISOString()));
    }
  }
  let nextId = 100;
  const dependencies = {
    database: makeDynamoDatabase(fake.client, TABLES),
    durableTransport: { append: async () => ({}), currentOffset: async () => "0" },
    endUserSubjects: endUserKeyDeriver(SUBJECT_SECRET),
    enqueueRun: async () => {},
    generateId: async () => `01ARZ3NDEKTSV4RRFFQ69G${String(nextId++).padStart(4, "0")}` as Ulid,
    now: () => now,
  } as unknown as RuntimeApiDependencies;
  const handler = createRuntimeApiHandler(dependencies);
  const request = async (
    method: string,
    path: string,
    options: { readonly body?: object; readonly key?: string; readonly headers?: object } = {},
  ) => {
    const result = await handler({
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      headers: { authorization: `Bearer ${options.key ?? KEY}`, ...options.headers },
      rawPath: path,
      requestContext: { http: { method } },
    });
    return { body: JSON.parse(result.body) as Record<string, any>, status: result.statusCode };
  };
  return { fake, request };
}

async function createThread(
  request: ReturnType<typeof fixture>["request"],
  body: Record<string, unknown> = {},
) {
  const created = await request("POST", "/v1/threads", {
    body: { agentDeploymentId: deploymentId, ...body },
  });
  expect(created.status).toBe(201);
  return String(created.body.id);
}

describe("thread erasure API", () => {
  test("starts an erasure, hides the thread at once, and replays the same erasure", async () => {
    const { request } = fixture();
    const threadId = await createThread(request);

    const started = await request("POST", `/v1/threads/${threadId}/erasures`);
    expect(started.status).toBe(202);
    expect(started.body.erasure).toMatchObject({
      kind: "thread",
      phase: "mail",
      status: "pending",
      threadId,
    });

    expect((await request("GET", `/v1/threads/${threadId}`)).status).toBe(404);
    const replay = await request("POST", `/v1/threads/${threadId}/erasures`);
    expect(replay).toEqual({ body: started.body, status: 200 });
    const polled = await request(
      "GET",
      `/v1/threads/${threadId}/erasures/${started.body.erasure.id}`,
    );
    expect(polled).toEqual({ body: started.body, status: 200 });
  });

  test("an API key of another environment cannot reach the thread", async () => {
    const { request } = fixture();
    const threadId = await createThread(request);

    const unscoped = await request("POST", `/v1/threads/${threadId}/erasures`, {
      key: FOREIGN_KEY,
    });
    const crossScoped = await request("POST", `/v1/threads/${threadId}/erasures`, {
      headers: {
        "x-deployments-environment": environmentId,
        "x-deployments-organization": organizationId,
        "x-deployments-project": projectId,
      },
      key: FOREIGN_KEY,
    });

    expect([unscoped.status, unscoped.body.code]).toEqual([404, "thread_not_found"]);
    expect([crossScoped.status, crossScoped.body.code]).toEqual([
      403,
      "environment_scope_violation",
    ]);
    expect((await request("GET", `/v1/threads/${threadId}`)).status).toBe(200);
  });

  test("an API key without runs:erase is refused", async () => {
    const { request } = fixture();
    const threadId = await createThread(request);

    const refused = await request("POST", `/v1/threads/${threadId}/erasures`, {
      key: WRITE_ONLY_KEY,
    });

    expect([refused.status, refused.body.code]).toEqual([403, "insufficient_scope"]);
  });

  test("a thread fenced by an end-user erasure is not found, and that erasure is left alone", async () => {
    const { fake, request } = fixture();
    const threadId = await createThread(request, { endUserId: "cus_8f2a91" });
    const started = await request("POST", "/v1/end-users/erasures", {
      body: { endUserId: "cus_8f2a91" },
    });
    const worker = makeConversationErasureStore(fake.client, TABLES, { now: () => now });
    const operation = (await worker.getOperation(organizationId, started.body.erasure.id))!;
    expect(await worker.planEndUserItems(operation)).toBe(1);
    const [item] = await worker.listItems(operation);
    expect((await worker.fenceItem(operation, item!)).kind).toBe("fenced");
    const pollPath = `/v1/end-users/erasures/${started.body.erasure.id}`;
    const before = await request("GET", pollPath);

    const replay = await request("POST", `/v1/threads/${threadId}/erasures`);

    expect([replay.status, replay.body.code]).toEqual([404, "thread_not_found"]);
    expect(await request("GET", pollPath)).toEqual(before);
  });
});

describe("end-user erasure API", () => {
  test("erases a subject without echoing it and blocks new threads for it", async () => {
    const { fake, request } = fixture();
    await createThread(request, { endUserId: "cus_8f2a91" });

    const started = await request("POST", "/v1/end-users/erasures", {
      body: { endUserId: "cus_8f2a91" },
    });
    expect(started.status).toBe(202);
    expect(started.body.erasure).toMatchObject({
      environmentId,
      kind: "end-user",
      phase: "planning",
      status: "pending",
    });
    expect(JSON.stringify(started.body)).not.toContain("cus_8f2a91");
    expect(
      JSON.stringify([
        ...fake.items("control"),
        ...fake.items("execution"),
        ...fake.items("events"),
      ]),
    ).not.toContain("cus_8f2a91");

    const replay = await request("POST", "/v1/end-users/erasures", {
      body: { endUserId: "cus_8f2a91" },
    });
    expect(replay).toEqual({ body: started.body, status: 200 });

    const racing = await request("POST", "/v1/threads", {
      body: { agentDeploymentId: deploymentId, endUserId: "cus_8f2a91" },
    });
    expect([racing.status, racing.body.code]).toEqual([409, "end_user_erasure_in_progress"]);
    await createThread(request, { endUserId: "cus_other" });
  });

  test("a tenant cannot claim a platform channel subject for a new thread", async () => {
    const { request } = fixture();

    const refused = await request("POST", "/v1/threads", {
      body: { agentDeploymentId: deploymentId, endUserId: "channel:slack_edge:T1:U1" },
    });

    expect([refused.status, refused.body.code]).toEqual([400, "invalid_request"]);
  });

  test("an email subject names one person however the address is cased", async () => {
    const { request } = fixture();

    const started = await request("POST", "/v1/end-users/erasures", {
      body: { endUserId: "channel:email:-:Alice@Example.com" },
    });
    const replay = await request("POST", "/v1/end-users/erasures", {
      body: { endUserId: "channel:email:-:alice%40example.com" },
    });
    const malformed = await request("POST", "/v1/end-users/erasures", {
      body: { endUserId: "channel:email:-:%zz" },
    });

    expect(started.status).toBe(202);
    expect(replay).toEqual({ body: started.body, status: 200 });
    expect([malformed.status, malformed.body.code]).toEqual([400, "invalid_request"]);
  });

  test("an organization's own inbox address is not an end user", async () => {
    const { fake, request } = fixture();
    const inbox = withCanonicalRecordKeys({
      data: {
        address: "support@agents.example.com",
        createdAt: now.toISOString(),
        domainId: localId(40),
        environmentId,
        id: localId(41),
        localPart: "support",
        metadata: {},
        organizationId,
        projectId,
        status: "active" as const,
        updatedAt: now.toISOString(),
        version: 1,
      },
      itemType: "inbox" as const,
    }) as PlatformRecord;
    fake.put("control", inbox);
    for (const requirement of uniqueClaimRequirements(inbox)) {
      fake.put("control", makeUniqueClaimRecord(requirement, now.toISOString()));
    }

    const refused = await request("POST", "/v1/end-users/erasures", {
      body: { endUserId: "channel:email:-:Support@Agents.Example.com" },
    });

    expect([refused.status, refused.body.code]).toEqual([409, "end_user_is_inbox"]);
  });

  test("an API key without end-users:erase is refused", async () => {
    const { request } = fixture();

    const refused = await request("POST", "/v1/end-users/erasures", {
      body: { endUserId: "cus_8f2a91" },
      key: WRITE_ONLY_KEY,
    });

    expect([refused.status, refused.body.code]).toEqual([403, "insufficient_scope"]);
  });
});
