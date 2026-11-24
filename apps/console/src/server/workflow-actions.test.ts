import { describe, expect, test } from "bun:test";
import { PlatformApiError } from "../errors.ts";
import { APPROVAL_DOCUMENT, TENANT } from "../workflows/model.fixture.ts";
import { createPlatformApiClient, type PlatformApiClient } from "./platform-api.ts";
import {
  archiveDefinition,
  archiveRelease,
  cancelExecution,
  createDefinition,
  publishRelease,
  resolveApproval,
  startExecution,
  updateDefinition,
} from "./workflow-actions.ts";

const EXECUTION_ID = "01K0000000000000000000000E";
const APPROVAL_ID = "01K0000000000000000000000Q";
const APPROVAL_PATH = `/v1/workflow-executions/${EXECUTION_ID}/approvals/${APPROVAL_ID}`;
const DEFINITION_ID = "01K0000000000000000000000D";
const RELEASE_ID = "01K0000000000000000000000R";
const HASH = `sha256:${"a".repeat(64)}`;

const definitionJson = (version: number, status = "active") => ({
  ...TENANT,
  createdAt: "2026-10-09T05:00:00.000Z",
  draft: APPROVAL_DOCUMENT,
  id: DEFINITION_ID,
  name: "QA approval gate",
  slug: "qa-approval-gate",
  status,
  updatedAt: "2026-10-09T05:00:00.000Z",
  version,
});

const releaseJson = (status: string) => ({
  ...TENANT,
  contentHash: HASH,
  createdAt: "2026-10-09T05:00:00.000Z",
  createdByPrincipalId: "01K0000000000000000000000P",
  definition: APPROVAL_DOCUMENT,
  id: RELEASE_ID,
  releaseNumber: 2,
  status,
  version: 1,
  workflowDefinitionId: DEFINITION_ID,
});

const keyed = { accessToken: "token", idempotencyKey: "dialog-key", scope: TENANT };

interface Sent {
  readonly body: unknown;
  readonly key: string | null;
  readonly method: string;
  readonly path: string;
}

function platform(respond: (request: { method: string; path: string }) => Response) {
  const sent: Sent[] = [];
  const client = createPlatformApiClient({
    baseUrl: "https://api.example.test",
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const path = new URL(request.url).pathname;
      sent.push({
        body: request.method === "GET" ? undefined : await request.json(),
        key: request.headers.get("idempotency-key"),
        method: request.method,
        path,
      });
      return respond({ method: request.method, path });
    }) as typeof globalThis.fetch,
  });
  return { client, sent };
}

function approval(status: string) {
  return {
    ...TENANT,
    createdAt: "2026-10-09T05:00:00.000Z",
    id: APPROVAL_ID,
    object: "workflow-approval",
    prompt: "QA: approve this execution?",
    status,
    stepAttemptId: APPROVAL_ID,
    updatedAt: "2026-10-09T05:01:00.000Z",
    version: 2,
    workflowExecutionId: EXECUTION_ID,
  };
}

const conflict = () =>
  Response.json(
    {
      code: "workflow_execution_conflict",
      detail: "Workflow approval is already canceled.",
      status: 409,
      title: "Conflict",
    },
    { headers: { "content-type": "application/problem+json" }, status: 409 },
  );

const decide = (decision: "approved" | "rejected", client: PlatformApiClient) =>
  resolveApproval(
    {
      accessToken: "token",
      approvalId: APPROVAL_ID,
      decision,
      executionId: EXECUTION_ID,
      scope: TENANT,
    },
    client,
  );

describe("resolveApproval", () => {
  test("reports an applied decision", async () => {
    const { client, sent } = platform(() => Response.json(approval("rejected")));
    expect(await decide("rejected", client)).toEqual({ kind: "applied", status: "rejected" });
    expect(sent).toEqual([
      {
        body: { decision: "rejected" },
        key: null,
        method: "POST",
        path: `${APPROVAL_PATH}/resolve`,
      },
    ]);
  });

  test("reports a 200 whose approval expired as expired, not applied", async () => {
    const { client } = platform(() => Response.json(approval("expired")));
    expect(await decide("approved", client)).toEqual({ kind: "expired" });
  });

  test("reads the approval after a conflict and reports it already closed", async () => {
    const { client, sent } = platform(({ method }) =>
      method === "POST" ? conflict() : Response.json(approval("canceled")),
    );
    expect(await decide("approved", client)).toEqual({
      kind: "already-closed",
      status: "canceled",
    });
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST ${APPROVAL_PATH}/resolve`,
      `GET ${APPROVAL_PATH}`,
    ]);
  });

  test("reports expired when the conflict's re-read finds the deadline already closed it", async () => {
    const { client, sent } = platform(({ method }) =>
      method === "POST" ? conflict() : Response.json(approval("expired")),
    );
    expect(await decide("approved", client)).toEqual({ kind: "expired" });
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST ${APPROVAL_PATH}/resolve`,
      `GET ${APPROVAL_PATH}`,
    ]);
  });

  test("keeps the conflict when the approval still reads as pending", async () => {
    const { client } = platform(({ method }) =>
      method === "POST" ? conflict() : Response.json(approval("pending")),
    );
    const error = await decide("approved", client).catch((caught: unknown) => caught);
    expect(error instanceof PlatformApiError && error.problem.code).toBe(
      "workflow_execution_conflict",
    );
  });
});

describe("createDefinition", () => {
  test("refuses a broken step graph with the contract's message and sends nothing", async () => {
    const { client, sent } = platform(() => Response.json({}, { status: 500 }));
    const error = await createDefinition(
      {
        accessToken: "token",
        document: { ...APPROVAL_DOCUMENT, entryStepId: "missing" },
        idempotencyKey: "dialog-key",
        scope: TENANT,
      },
      client,
    ).catch((caught: unknown) => caught);
    expect(error instanceof PlatformApiError && error.problem).toEqual({
      detail: "Workflow entryStepId must reference a declared step.",
      status: 400,
      title: "Invalid workflow definition",
    });
    expect(sent).toEqual([]);
  });

  test("sends the decoded draft under the dialog's key", async () => {
    const { client, sent } = platform(() => Response.json(definitionJson(0), { status: 201 }));
    expect<unknown>(
      await createDefinition({ ...keyed, document: APPROVAL_DOCUMENT }, client),
    ).toEqual({ id: DEFINITION_ID });
    expect(sent).toEqual([
      {
        body: { definition: APPROVAL_DOCUMENT },
        key: "dialog-key",
        method: "POST",
        path: "/v1/workflow-definitions",
      },
    ]);
  });
});

describe("startExecution", () => {
  test("omits input when the dialog left it empty", async () => {
    const { client, sent } = platform(() => Response.json({}, { status: 500 }));
    await startExecution(
      {
        accessToken: "token",
        idempotencyKey: "dialog-key",
        input: undefined,
        releaseId: "01K0000000000000000000000R",
        scope: TENANT,
      },
      client,
    ).catch(() => undefined);
    expect(sent[0]).toEqual({
      body: {},
      key: "dialog-key",
      method: "POST",
      path: "/v1/workflow-releases/01K0000000000000000000000R/executions",
    });
  });
});

describe("definition and release writes", () => {
  test("updateDefinition patches the draft at the version the editor loaded", async () => {
    const { client, sent } = platform(() => Response.json(definitionJson(4)));
    expect(
      await updateDefinition(
        { ...keyed, definitionId: DEFINITION_ID, document: APPROVAL_DOCUMENT, expectedVersion: 3 },
        client,
      ),
    ).toEqual({ version: 4 });
    expect(sent).toEqual([
      {
        body: { definition: APPROVAL_DOCUMENT, expectedVersion: 3 },
        key: "dialog-key",
        method: "PATCH",
        path: `/v1/workflow-definitions/${DEFINITION_ID}`,
      },
    ]);
  });

  test("archiveDefinition deletes at the expected version", async () => {
    const { client, sent } = platform(() => Response.json(definitionJson(4, "archived")));
    expect(
      await archiveDefinition(
        { ...keyed, definitionId: DEFINITION_ID, expectedVersion: 3 },
        client,
      ),
    ).toEqual({ status: "archived" });
    expect(sent).toEqual([
      {
        body: { expectedVersion: 3 },
        key: "dialog-key",
        method: "DELETE",
        path: `/v1/workflow-definitions/${DEFINITION_ID}`,
      },
    ]);
  });

  test("publishRelease publishes the draft version the dialog showed", async () => {
    const { client, sent } = platform(() => Response.json(releaseJson("active"), { status: 201 }));
    expect<unknown>(
      await publishRelease(
        { ...keyed, definitionId: DEFINITION_ID, expectedDefinitionVersion: 3 },
        client,
      ),
    ).toEqual({ id: RELEASE_ID, releaseNumber: 2 });
    expect(sent).toEqual([
      {
        body: { expectedDefinitionVersion: 3 },
        key: "dialog-key",
        method: "POST",
        path: `/v1/workflow-definitions/${DEFINITION_ID}/releases`,
      },
    ]);
  });

  test("archiveRelease deletes the release at its expected version", async () => {
    const { client, sent } = platform(() => Response.json(releaseJson("archived")));
    expect(
      await archiveRelease({ ...keyed, expectedVersion: 1, releaseId: RELEASE_ID }, client),
    ).toEqual({ status: "archived" });
    expect(sent).toEqual([
      {
        body: { expectedVersion: 1 },
        key: "dialog-key",
        method: "DELETE",
        path: `/v1/workflow-releases/${RELEASE_ID}`,
      },
    ]);
  });
});

describe("cancelExecution", () => {
  test("posts the expected version without an idempotency key", async () => {
    const { client, sent } = platform(() =>
      Response.json({
        ...TENANT,
        createdAt: "2026-10-09T05:00:00.000Z",
        id: EXECUTION_ID,
        input: {},
        object: "workflow-execution",
        status: "canceling",
        updatedAt: "2026-10-09T05:02:00.000Z",
        version: 3,
        workflowContentHash: HASH,
        workflowDefinitionId: DEFINITION_ID,
        workflowReleaseId: RELEASE_ID,
        workflowReleaseNumber: 2,
      }),
    );
    expect(
      await cancelExecution(
        { accessToken: "token", executionId: EXECUTION_ID, expectedVersion: 2, scope: TENANT },
        client,
      ),
    ).toEqual({ status: "canceling" });
    expect(sent).toEqual([
      {
        body: { expectedVersion: 2 },
        key: null,
        method: "POST",
        path: `/v1/workflow-executions/${EXECUTION_ID}/cancel`,
      },
    ]);
  });
});
