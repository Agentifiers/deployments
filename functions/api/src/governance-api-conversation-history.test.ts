import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TABLE_NAMES,
  makeDynamoGovernanceStore,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import {
  createGovernanceService,
  type GovernanceObjectStore,
  type GovernanceSigner,
} from "@deployments-ai/governance";
import { createGovernanceApiHandler } from "./governance-api.ts";
import { ORGANIZATION_ID, PRINCIPAL_ID, request } from "./governance-api.fixture.ts";

const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB1";
const THREAD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const RETRIED_THREAD_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
const END_USER_KEY = `v1.${"k".repeat(43)}`;
const HISTORY = `/v1/organizations/${ORGANIZATION_ID}/governance-operations`;

const TENANT_EXPORT = "01ARZ3NDEKTSV4RRFFQ69G5FC1";
const THREAD_ERASURE = "01ARZ3NDEKTSV4RRFFQ69G5FC2";
const TENANT_ERASURE = "01ARZ3NDEKTSV4RRFFQ69G5FC3";
const RUNNING_END_USER_ERASURE = "01ARZ3NDEKTSV4RRFFQ69G5FC4";
const RETRYING_THREAD_ERASURE = "01ARZ3NDEKTSV4RRFFQ69G5FC5";
const FAILED_END_USER_ERASURE = "01ARZ3NDEKTSV4RRFFQ69G5FC6";

const COUNTS = {
  automationsArchived: 1,
  emailMessagesErased: 10,
  emailThreadsErased: 11,
  ingressRecordsDeleted: 2,
  memoriesErased: 3,
  objectsStaged: 4,
  recordsDeleted: 5,
  runsCanceled: 6,
  streamsDeleted: 7,
  threadsErased: 8,
  threadsPlanned: 9,
};

interface SeededOperation {
  readonly completedAt?: string;
  readonly conversationErasure?: Readonly<Record<string, unknown>>;
  readonly error?: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly kind: string;
  readonly minute: number;
  readonly status: string;
}

const SEEDED: readonly SeededOperation[] = [
  { id: TENANT_EXPORT, kind: "tenant-export", minute: 0, status: "pending" },
  {
    completedAt: "2026-10-07T12:01:30.000Z",
    conversationErasure: {
      counts: COUNTS,
      environmentId: ENVIRONMENT_ID,
      phase: "finalizing",
      target: { kind: "thread", threadId: THREAD_ID },
    },
    id: THREAD_ERASURE,
    kind: "thread-erasure",
    minute: 1,
    status: "completed",
  },
  { id: TENANT_ERASURE, kind: "tenant-erasure", minute: 2, status: "running" },
  {
    conversationErasure: {
      counts: COUNTS,
      environmentId: ENVIRONMENT_ID,
      phase: "canonical",
      target: { endUserKey: END_USER_KEY, kind: "end-user" },
    },
    id: RUNNING_END_USER_ERASURE,
    kind: "end-user-erasure",
    minute: 3,
    status: "running",
  },
  {
    conversationErasure: {
      counts: COUNTS,
      environmentId: ENVIRONMENT_ID,
      phase: "memory",
      target: { kind: "thread", threadId: RETRIED_THREAD_ID },
    },
    error: {
      code: "memory_search_unavailable",
      message: "raw cause for jane@example.com",
    },
    id: RETRYING_THREAD_ERASURE,
    kind: "thread-erasure",
    minute: 4,
    status: "pending",
  },
  {
    conversationErasure: {
      counts: COUNTS,
      environmentId: ENVIRONMENT_ID,
      phase: "objects",
      target: { kind: "end-user" },
    },
    error: { code: "erasure_failed", message: "Object erasure failed." },
    id: FAILED_END_USER_ERASURE,
    kind: "end-user-erasure",
    minute: 5,
    status: "failed",
  },
];

function at(minute: number) {
  return `2026-10-07T12:0${minute}:00.000Z`;
}

const unexpectedPort = new Proxy(
  {},
  {
    get: () => () => {
      throw new Error("History reads use no governance object or signing port.");
    },
  },
);

function historyApi() {
  const fake = fakeDynamoDocumentClient();
  const control = DEFAULT_TABLE_NAMES.control;
  fake.put(
    control,
    withCanonicalRecordKeys({
      data: {
        createdAt: at(0),
        id: ORGANIZATION_ID,
        name: "Acme",
        slug: "acme",
        status: "active",
        updatedAt: at(0),
        version: 1,
      },
      itemType: "organization",
    }),
  );
  for (const operation of SEEDED) {
    const { minute, ...fields } = operation;
    fake.put(
      control,
      withCanonicalRecordKeys({
        data: {
          ...fields,
          createdAt: at(minute),
          idempotencyKey: `idempotency-${operation.id}`,
          organizationId: ORGANIZATION_ID,
          requestedByPrincipalId: PRINCIPAL_ID,
          updatedAt: at(minute),
          version: 1,
        },
        itemType: "governance-operation",
      }),
    );
    fake.put(
      control,
      withCanonicalRecordKeys({
        data: {
          createdAt: at(minute),
          kind: operation.kind,
          operationId: operation.id,
          organizationId: ORGANIZATION_ID,
        },
        itemType: "governance-operation-history",
      }),
    );
  }
  const handler = createGovernanceApiHandler({
    authenticate: async () => ({
      authentication: "tenant-jwt",
      organizationIds: [ORGANIZATION_ID],
      organizationRole: "viewer",
      principalId: PRINCIPAL_ID,
      scopes: ["governance:read"],
    }),
    createDownloadUrl: async () => {
      throw new Error("History items here carry no downloadable output.");
    },
    dispatchCompletion: () => [],
    enqueue: async () => {},
    idempotency: {
      execute: async () => Promise.reject(new Error("History reads are not idempotent writes.")),
    },
    service: createGovernanceService({
      allowedObjectBuckets: [],
      generateId: async () => "01ARZ3NDEKTSV4RRFFQ69G5FD0",
      objectStore: unexpectedPort as GovernanceObjectStore,
      signer: unexpectedPort as GovernanceSigner,
      store: makeDynamoGovernanceStore(fake.client, DEFAULT_TABLE_NAMES),
    }),
  });
  return async (query = "") => {
    const response = await handler(request(`${HISTORY}${query}`));
    return {
      body: (await response?.json()) as {
        readonly items: readonly Readonly<Record<string, unknown>>[];
        readonly nextCursor?: string;
      },
      status: response?.status,
    };
  };
}

const ids = (body: { readonly items: readonly Readonly<Record<string, unknown>>[] }) =>
  body.items.map((item) => item.id);

describe("governance history of conversation erasures", () => {
  test("lists thread and end-user erasures beside tenant operations with the public projection", async () => {
    const history = historyApi();

    const all = await history();

    expect(all.status).toBe(200);
    expect(all.body.items.map((item) => [item.id, item.kind])).toEqual([
      [FAILED_END_USER_ERASURE, "end-user-erasure"],
      [RETRYING_THREAD_ERASURE, "thread-erasure"],
      [RUNNING_END_USER_ERASURE, "end-user-erasure"],
      [TENANT_ERASURE, "tenant-erasure"],
      [THREAD_ERASURE, "thread-erasure"],
      [TENANT_EXPORT, "tenant-export"],
    ]);
    expect(
      all.body.items.filter(
        (item) => item.kind === "thread-erasure" || item.kind === "end-user-erasure",
      ),
    ).toEqual([
      {
        counts: COUNTS,
        createdAt: at(5),
        environmentId: ENVIRONMENT_ID,
        error: { code: "erasure_failed", message: "Object erasure failed." },
        id: FAILED_END_USER_ERASURE,
        kind: "end-user-erasure",
        phase: "objects",
        status: "failed",
        updatedAt: at(5),
      },
      {
        counts: COUNTS,
        createdAt: at(4),
        environmentId: ENVIRONMENT_ID,
        id: RETRYING_THREAD_ERASURE,
        kind: "thread-erasure",
        phase: "memory",
        status: "pending",
        threadId: RETRIED_THREAD_ID,
        updatedAt: at(4),
      },
      {
        counts: COUNTS,
        createdAt: at(3),
        environmentId: ENVIRONMENT_ID,
        id: RUNNING_END_USER_ERASURE,
        kind: "end-user-erasure",
        phase: "canonical",
        status: "running",
        updatedAt: at(3),
      },
      {
        completedAt: "2026-10-07T12:01:30.000Z",
        counts: COUNTS,
        createdAt: at(1),
        environmentId: ENVIRONMENT_ID,
        id: THREAD_ERASURE,
        kind: "thread-erasure",
        phase: "finalizing",
        status: "completed",
        threadId: THREAD_ID,
        updatedAt: at(1),
      },
    ]);
    const serialized = JSON.stringify(all.body);
    expect(serialized).not.toContain(END_USER_KEY);
    expect(serialized).not.toContain("jane@example.com");
    expect(serialized).not.toContain("idempotency-");
    expect(serialized).not.toContain(PRINCIPAL_ID);
  });

  test("filters by conversation erasure kind and by status", async () => {
    const history = historyApi();

    const threads = await history("?kind=thread-erasure");
    const endUsers = await history("?kind=end-user-erasure");
    const failed = await history("?status=failed");
    const completedThreads = await history("?kind=thread-erasure&status=completed");

    expect([threads.status, endUsers.status, failed.status, completedThreads.status]).toEqual([
      200, 200, 200, 200,
    ]);
    expect(ids(threads.body)).toEqual([RETRYING_THREAD_ERASURE, THREAD_ERASURE]);
    expect(ids(endUsers.body)).toEqual([FAILED_END_USER_ERASURE, RUNNING_END_USER_ERASURE]);
    expect(ids(failed.body)).toEqual([FAILED_END_USER_ERASURE]);
    expect(ids(completedThreads.body)).toEqual([THREAD_ERASURE]);
  });

  test("pages across every kind with the cursor", async () => {
    const history = historyApi();
    const pages: unknown[][] = [];

    let cursor: string | undefined;
    do {
      const page = await history(
        `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      expect(page.status).toBe(200);
      pages.push(ids(page.body));
      cursor = page.body.nextCursor;
    } while (cursor);

    expect(pages).toEqual([
      [FAILED_END_USER_ERASURE, RETRYING_THREAD_ERASURE],
      [RUNNING_END_USER_ERASURE, TENANT_ERASURE],
      [THREAD_ERASURE, TENANT_EXPORT],
    ]);
  });
});
