import { describe, expect, test } from "bun:test";
import { APPROVAL_DOCUMENT, attemptJson, TENANT } from "../workflows/model.fixture.ts";
import { createPlatformApiClient } from "./platform-api.ts";
import {
  loadApprovalQueue,
  loadDefinitionPage,
  loadExecutionDetail,
  loadRelatedExecutions,
  type Platform,
} from "./workflow-data.ts";

const SCOPE = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G600G",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G600C",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G600D",
};

interface Input {
  readonly path?: Readonly<Record<string, string>>;
  readonly query?: { readonly cursor?: string; readonly limit?: number; readonly status?: string };
}

interface Call {
  readonly input: Input;
  readonly name: string;
}

function paged<Row>(rows: readonly Row[]) {
  return ({ query }: Input) => {
    const offset = Number(query?.cursor ?? 0);
    const end = offset + Math.min(query?.limit ?? 100, 100);
    return {
      items: rows.slice(offset, end),
      ...(end < rows.length ? { nextCursor: String(end) } : {}),
    };
  };
}

function platform(responses: Readonly<Record<string, (input: Input) => unknown>>) {
  const calls: Call[] = [];
  const callRoute = async (name: string, input: Input) => {
    calls.push({ input, name });
    const respond = responses[name];
    if (!respond) throw new Error(`unexpected ${name}`);
    return respond(input);
  };
  // The fake answers only the routes a test names, so it cannot satisfy every route's typed result.
  const client = { callRoute } as unknown as Platform;
  return { calls, client };
}

const definitions = (statuses: readonly string[]) =>
  statuses.map((status, index) => ({ id: `def-${index}`, status }));

const limits = (calls: readonly Call[]) => calls.map(({ input }) => input.query?.limit);

describe("loadDefinitionPage", () => {
  test("a filtered page holds at most 50 rows and asks only for the rows it still needs", async () => {
    const rows = definitions(
      Array.from({ length: 200 }, (_, index) => (index % 2 === 0 ? "active" : "archived")),
    );
    const { calls, client } = platform({ listWorkflowDefinitions: paged(rows) });
    const page = await loadDefinitionPage("token", SCOPE, {}, undefined, client);
    expect<readonly string[]>(page.items.map(({ id }) => id)).toEqual(
      Array.from({ length: 50 }, (_, index) => `def-${index * 2}`),
    );
    expect(page.nextCursor).toBe("99");
    expect(limits(calls)).toEqual([50, 25, 12, 6, 3, 2, 1]);
  });

  test("the archived view keeps only archived definitions", async () => {
    const rows = definitions(["active", "archived", "active", "archived"]);
    const { client } = platform({ listWorkflowDefinitions: paged(rows) });
    const page = await loadDefinitionPage(
      "token",
      SCOPE,
      { status: "archived" },
      undefined,
      client,
    );
    expect<unknown>(page).toEqual({
      items: [
        { id: "def-1", status: "archived" },
        { id: "def-3", status: "archived" },
      ],
    });
  });

  test("the combined view returns one page of 50 from one request", async () => {
    const rows = definitions(Array.from({ length: 120 }, () => "archived"));
    const { calls, client } = platform({ listWorkflowDefinitions: paged(rows) });
    const page = await loadDefinitionPage("token", SCOPE, { status: "all" }, undefined, client);
    expect(page.items).toHaveLength(50);
    expect(page.nextCursor).toBe("50");
    expect(limits(calls)).toEqual([50]);
  });

  test("an environment with only archived definitions has an empty default view and no cursor", async () => {
    const rows = definitions(["archived", "archived", "archived"]);
    const { calls, client } = platform({ listWorkflowDefinitions: paged(rows) });
    expect(await loadDefinitionPage("token", SCOPE, {}, undefined, client)).toEqual({ items: [] });
    expect(calls).toHaveLength(1);
  });
});

const executions = (count: number, belongs: (index: number) => boolean) =>
  Array.from({ length: count }, (_, index) => ({
    id: `exe-${index}`,
    status: "completed",
    workflowDefinitionId: belongs(index) ? "def-mine" : "def-other",
    workflowReleaseId: belongs(index) ? "rel-mine" : "rel-other",
  }));

describe("loadRelatedExecutions", () => {
  test("keeps a definition's executions from five full pages and reads the scan as complete at exactly 500", async () => {
    const { calls, client } = platform({
      listWorkflowExecutions: paged(executions(500, (index) => index % 125 === 0)),
    });
    const scan = await loadRelatedExecutions("token", SCOPE, { definitionId: "def-mine" }, client);
    expect(scan.complete).toBe(true);
    expect<readonly string[]>(scan.items.map(({ id }) => id)).toEqual([
      "exe-0",
      "exe-125",
      "exe-250",
      "exe-375",
    ]);
    expect(calls.map(({ input }) => input.query)).toEqual([
      { limit: 100 },
      { cursor: "100", limit: 100 },
      { cursor: "200", limit: 100 },
      { cursor: "300", limit: 100 },
      { cursor: "400", limit: 100 },
    ]);
  });

  test("matches a release and reads the scan as incomplete past five pages", async () => {
    const { calls, client } = platform({
      listWorkflowExecutions: paged(executions(501, (index) => index === 7 || index === 500)),
    });
    const scan = await loadRelatedExecutions("token", SCOPE, { releaseId: "rel-mine" }, client);
    expect<unknown>(scan).toEqual({
      complete: false,
      items: [
        {
          id: "exe-7",
          status: "completed",
          workflowDefinitionId: "def-mine",
          workflowReleaseId: "rel-mine",
        },
      ],
    });
    expect(calls).toHaveLength(5);
  });

  test("an environment without executions is a complete empty scan", async () => {
    const { client } = platform({ listWorkflowExecutions: paged([]) });
    expect(await loadRelatedExecutions("token", SCOPE, { releaseId: "rel-mine" }, client)).toEqual({
      complete: true,
      items: [],
    });
  });
});

describe("loadExecutionDetail", () => {
  const attempts = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ id: `att-${index}` }));

  test("reads at most three pages of step attempts", async () => {
    const { calls, client } = platform({
      getWorkflowExecution: () => ({ id: "exe-1", status: "running" }),
      listWorkflowStepAttempts: paged(attempts(301)),
    });
    const detail = await loadExecutionDetail("token", SCOPE, "exe-1", client);
    expect<unknown>(detail.execution).toEqual({ id: "exe-1", status: "running" });
    expect(detail.attempts.complete).toBe(false);
    expect<unknown>(detail.attempts.items.at(-1)).toEqual({ id: "att-299" });
    expect(detail.attempts.items).toHaveLength(300);
    expect(
      calls
        .filter(({ name }) => name === "listWorkflowStepAttempts")
        .map(({ input }) => [input.path, input.query?.limit]),
    ).toEqual([
      [{ workflowExecutionId: "exe-1" }, 100],
      [{ workflowExecutionId: "exe-1" }, 100],
      [{ workflowExecutionId: "exe-1" }, 100],
    ]);
  });

  test("reads exactly 300 step attempts as complete", async () => {
    const { client } = platform({
      getWorkflowExecution: () => ({ id: "exe-1", status: "completed" }),
      listWorkflowStepAttempts: paged(attempts(300)),
    });
    const detail = await loadExecutionDetail("token", SCOPE, "exe-1", client);
    expect(detail.attempts.complete).toBe(true);
    expect(detail.attempts.items).toHaveLength(300);
  });
});

const RELEASE_ID = "01K0000000000000000000000R";
const HASH = `sha256:${"a".repeat(64)}`;

function execution(id: string) {
  return {
    ...TENANT,
    createdAt: "2026-10-09T05:00:00.000Z",
    currentStepId: "review",
    id,
    status: "waiting-for-approval",
    updatedAt: "2026-10-09T05:00:00.000Z",
    version: 2,
    workflowContentHash: HASH,
    workflowDefinitionId: "01K0000000000000000000000D",
    workflowReleaseId: RELEASE_ID,
    workflowReleaseNumber: 1,
  };
}

const RELEASE = {
  ...TENANT,
  contentHash: HASH,
  createdAt: "2026-10-09T05:00:00.000Z",
  createdByPrincipalId: "01K0000000000000000000000P",
  definition: APPROVAL_DOCUMENT,
  id: RELEASE_ID,
  releaseNumber: 1,
  status: "active",
  version: 1,
  workflowDefinitionId: "01K0000000000000000000000D",
};

describe("loadApprovalQueue", () => {
  test("joins waiting executions to their approval step and reads each release once", async () => {
    const requested: string[] = [];
    const client = createPlatformApiClient({
      baseUrl: "https://api.example.test",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(new Request(input, init).url);
        requested.push(`${url.pathname}${url.search}`);
        if (url.pathname === "/v1/workflow-executions") {
          return Response.json({
            items: [
              execution("01K00000000000000000000E01"),
              execution("01K00000000000000000000E02"),
            ],
          });
        }
        const steps = url.pathname.match(/^\/v1\/workflow-executions\/(\w+)\/steps$/u);
        if (steps) {
          const executionId = steps[1];
          return Response.json({
            items: [
              attemptJson({
                approvalId: executionId?.replace("E0", "A0"),
                startedAt: "2026-10-09T05:01:00.000Z",
                status: "waiting",
                workflowExecutionId: executionId,
              }),
            ],
          });
        }
        return Response.json(RELEASE);
      }) as typeof globalThis.fetch,
    });

    const queue = await loadApprovalQueue("token", TENANT, client);

    expect(queue).toEqual({
      complete: true,
      items: ["01", "02"].map((suffix) => ({
        approvalId: `01K00000000000000000000A${suffix}`,
        executionId: `01K00000000000000000000E${suffix}`,
        prompt: "QA: approve this execution?",
        releaseId: RELEASE_ID,
        releaseNumber: 1,
        stepId: "review",
        waitingSince: "2026-10-09T05:01:00.000Z",
        workflowName: "QA approval gate",
      })),
    });
    expect(requested.filter((path) => path.startsWith("/v1/workflow-releases/"))).toEqual([
      `/v1/workflow-releases/${RELEASE_ID}`,
    ]);
    expect(requested.filter((path) => path.includes("/approvals/"))).toEqual([]);
  });

  test("reads as incomplete when an execution's step attempts ran past the scan without a waiting approval", async () => {
    const { client } = platform({
      listWorkflowExecutions: () => ({ items: [execution("01K00000000000000000000E01")] }),
      listWorkflowStepAttempts: paged(
        Array.from({ length: 301 }, (_, index) =>
          attemptJson({ id: `att-${index}`, status: "succeeded" }),
        ),
      ),
    });
    expect(await loadApprovalQueue("token", TENANT, client)).toEqual({
      complete: false,
      items: [],
    });
  });
});
