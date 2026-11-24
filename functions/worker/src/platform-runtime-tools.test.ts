import { describe, expect, test } from "bun:test";
import {
  key,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { ConversationError } from "@deployments-ai/conversations";
import { RuntimeToolPreparationRetryableError } from "@deployments-ai/agent-runtime";
import {
  classifyDelegationFailure,
  createRuntimeAgentDelegationBuiltinExecutors,
  delegationSubmissionIdempotencyKey,
  loadDelegationParentRun,
} from "./agent-delegation-runtime-tools.ts";
import { createRuntimeAgentRegistryBuiltinExecutors } from "./agent-registry-runtime-tools.ts";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";
import { queryRecordPages } from "./builtin-tool-support.ts";
import {
  createRuntimeScheduleBuiltinExecutors,
  scheduleCreationIdempotencyKey,
} from "./schedule-runtime-tools.ts";

const ids = Array.from(
  { length: 20 },
  (_, index) => `01J000000000000000000000${String(index).padStart(2, "0")}` as Ulid,
);
const organizationId = ids[0]!;
const projectId = ids[1]!;
const environmentId = ids[2]!;
const workspaceId = ids[3]!;

const request = {
  agentDefinitionId: ids[4]!,
  agentDeploymentId: ids[5]!,
  agentReleaseId: ids[6]!,
  decision: {
    action: "allow" as const,
    reason: "test",
    toolCallId: ids[7]!,
  },
  effect: "read" as const,
  environmentId,
  idempotencyKey: "runtime-tool-test",
  inputSummary: "test",
  organizationId,
  projectId,
  requiredScopes: [],
  runId: ids[8]!,
  threadId: ids[9]!,
  toolName: "agent.registry.search",
  workspaceId,
};

function rawRecord(itemType: PlatformRecord["itemType"], data: Record<string, unknown>) {
  return { data, itemType, pk: "test", sk: "test" } as unknown as PlatformRecord;
}

// Free-form delegation: the calling release declares no sub-agents.
const callingRelease = rawRecord("agent-release", {
  environmentId,
  id: request.agentReleaseId,
  manifest: { metadata: { key: "caller" }, spec: {} },
  organizationId,
  projectId,
});

function database(options: {
  readonly get?: (recordKey: {
    readonly pk: string;
    readonly sk: string;
  }) => PlatformRecord | undefined;
  readonly query?: (input: Readonly<Record<string, unknown>>) => {
    readonly items: readonly PlatformRecord[];
    readonly lastEvaluatedKey?: Record<string, unknown>;
  };
}): DynamoDatabaseService {
  return {
    deleteRecord: async () => {},
    getRecord: (_table, recordKey) => Promise.resolve(options.get?.(recordKey)),
    putRecord: async () => {},
    queryRecords: (_table, input) => Promise.resolve(options.query?.(input) ?? { items: [] }),
    transactWrite: async () => {},
  };
}

function artifactValue(result: Awaited<ReturnType<ExecuteRuntimeBuiltinTool>>) {
  return JSON.parse(String(result.artifacts?.[0]?.content)) as unknown;
}

describe("platform registry and delegation executors", () => {
  test("exhausts shared-index pagination beyond ten physical pages", async () => {
    let page = 0;
    const db = database({
      query: () => {
        const current = page++;
        return {
          items: [rawRecord("agent-definition", { id: ids[current % ids.length] })],
          ...(current < 11 ? { lastEvaluatedKey: { page: current + 1 } } : {}),
        };
      },
    });
    const records = await queryRecordPages({
      database: db,
      input: { ExpressionAttributeValues: { ":pk": "shared" }, Limit: 1 },
      table: "control",
    });
    expect(records).toHaveLength(12);
    expect(page).toBe(12);
  });

  test("retries idempotent delegation reconciliation after post-commit failures", () => {
    expect(
      classifyDelegationFailure(
        "agent.delegate",
        new ConversationError("stream_unavailable", "stream unavailable"),
      ),
    ).toBeInstanceOf(RuntimeToolPreparationRetryableError);
    expect(
      classifyDelegationFailure(
        "agent.delegate",
        new ConversationError("invalid_request", "invalid"),
      ),
    ).toBeInstanceOf(TypeError);
    expect(
      classifyDelegationFailure("agent.delegate", new Error("queue unavailable")),
    ).toBeInstanceOf(RuntimeToolPreparationRetryableError);
  });

  test("uses caller-stable delegation identity across model call indexes", () => {
    const first = delegationSubmissionIdempotencyKey({
      ...request,
      idempotencyKey: "model-call-1",
      input: { idempotencyKey: "delegate-release-a" },
      toolName: "agent.delegate",
    });
    const second = delegationSubmissionIdempotencyKey({
      ...request,
      idempotencyKey: "model-call-2",
      input: { idempotencyKey: "delegate-release-a" },
      toolName: "agent.delegate",
    });
    expect(first).toBe(second);
    const boundedDefault = delegationSubmissionIdempotencyKey({
      ...request,
      idempotencyKey: "é".repeat(256),
      toolName: "agent.delegate",
    });
    expect(boundedDefault).not.toBe(first);
    expect(new TextEncoder().encode(boundedDefault).byteLength).toBeLessThanOrEqual(256);
  });

  test("retries delegation database failures before child submission", async () => {
    const failing = {
      ...database({}),
      getRecord: () => Promise.reject(new Error("DynamoDB unavailable")),
    } as unknown as DynamoDatabaseService;
    const executor = createRuntimeAgentDelegationBuiltinExecutors({
      database: failing,
      enqueueRun: async () => undefined,
      generateId: async () => ids[18]!,
    })["agent.delegate"];
    expect(
      executor(
        {
          ...request,
          effect: "execute",
          input: { prompt: "Investigate", targetAgentId: ids[10] },
          toolName: "agent.delegate",
        },
        {} as never,
      ),
    ).rejects.toBeInstanceOf(RuntimeToolPreparationRetryableError);
  });

  test.each([-1, 1.5, 100_000_000])(
    "rejects invalid delegation priority %p before database reads",
    async (priority) => {
      let reads = 0;
      const db = {
        ...database({}),
        getRecord: () => {
          reads += 1;
          return Promise.resolve(undefined);
        },
      } as DynamoDatabaseService;
      const executor = createRuntimeAgentDelegationBuiltinExecutors({
        database: db,
        enqueueRun: async () => undefined,
        generateId: async () => ids[18]!,
      })["agent.delegate"];
      expect(
        executor(
          {
            ...request,
            effect: "execute",
            input: { priority, prompt: "Investigate", targetAgentId: ids[10] },
            toolName: "agent.delegate",
          },
          {} as never,
        ),
      ).rejects.toThrow("priority");
      expect(reads).toBe(0);
    },
  );

  test("rejects excess delegation constraints before database reads", async () => {
    let reads = 0;
    const db = {
      ...database({}),
      getRecord: () => {
        reads += 1;
        return Promise.resolve(undefined);
      },
    } as DynamoDatabaseService;
    const executor = createRuntimeAgentDelegationBuiltinExecutors({
      database: db,
      enqueueRun: async () => undefined,
      generateId: async () => ids[18]!,
    })["agent.delegate"];
    expect(
      executor(
        {
          ...request,
          effect: "execute",
          input: {
            constraints: Array.from({ length: 51 }, (_, index) => `constraint-${index}`),
            prompt: "Investigate",
            targetAgentId: ids[10],
          },
          toolName: "agent.delegate",
        },
        {} as never,
      ),
    ).rejects.toThrow("at most 50");
    expect(reads).toBe(0);
  });

  test("rejects delegation payloads that cannot fit durable records before database reads", async () => {
    let reads = 0;
    const db = {
      ...database({}),
      getRecord: () => {
        reads += 1;
        return Promise.resolve(undefined);
      },
    } as DynamoDatabaseService;
    const executor = createRuntimeAgentDelegationBuiltinExecutors({
      database: db,
      enqueueRun: async () => undefined,
      generateId: async () => ids[18]!,
    })["agent.delegate"];
    expect(
      executor(
        {
          ...request,
          effect: "execute",
          input: {
            metadata: { oversized: "x".repeat(400 * 1_024) },
            prompt: "Investigate",
            targetAgentId: ids[10],
          },
          toolName: "agent.delegate",
        },
        {} as never,
      ),
    ).rejects.toThrow("durable record size limit");
    expect(reads).toBe(0);
  });

  test("does not delegate an environment-scoped run to a workspace-bound agent", async () => {
    const definition = rawRecord("agent-definition", {
      environmentId,
      id: ids[10],
      name: "Workspace specialist",
      organizationId,
      projectId,
      slug: "workspace-specialist",
      status: "active",
      workspaceId,
    });
    const db = database({
      get: (recordKey) =>
        recordKey.sk === key("AGENT-DEFINITION", ids[10]!)
          ? definition
          : recordKey.sk === key("AGENT-RELEASE", request.agentReleaseId)
            ? callingRelease
            : undefined,
      query: () => {
        throw new Error("A workspace-mismatched target must be rejected before deployment lookup.");
      },
    });
    const executor = createRuntimeAgentDelegationBuiltinExecutors({
      database: db,
      enqueueRun: async () => undefined,
      generateId: async () => ids[18]!,
    })["agent.delegate"];
    const { workspaceId: _workspaceId, ...environmentRequest } = request;
    expect(
      executor(
        {
          ...environmentRequest,
          effect: "execute",
          input: { prompt: "Investigate", targetAgentId: ids[10] },
          toolName: "agent.delegate",
        },
        {} as never,
      ),
    ).rejects.toThrow("current scope");
  });

  test("loads delegation parents through the exact run lookup", async () => {
    const lookup = rawRecord("run-lookup", {
      environmentId,
      idempotencyKey: "parent-run-key",
      organizationId,
      projectId,
      runId: request.runId,
      threadId: request.threadId,
    });
    const run = rawRecord("run", {
      environmentId,
      id: request.runId,
      idempotencyKey: "parent-run-key",
      organizationId,
      projectId,
      threadId: request.threadId,
    });
    const db = database({
      get: (recordKey) => {
        if (recordKey.sk === key("RUN-LOOKUP", request.runId)) return lookup;
        if (recordKey.sk === key("RUN", "parent-run-key")) return run;
        return undefined;
      },
      query: () => {
        throw new Error("Parent run loading must not scan the thread partition.");
      },
    });
    expect(await loadDelegationParentRun(db, request)).toMatchObject({
      data: { id: request.runId, idempotencyKey: "parent-run-key" },
      itemType: "run",
    });
  });

  test("paginates registry indexes, derives paused status, and excludes another project", async () => {
    const definition = rawRecord("agent-definition", {
      environmentId,
      id: ids[10],
      name: "Paused specialist",
      organizationId,
      projectId,
      slug: "paused-specialist",
      status: "active",
      workspaceId,
    });
    const otherProject = rawRecord("agent-definition", {
      environmentId,
      id: ids[11],
      name: "Other project",
      organizationId,
      projectId: ids[19],
      slug: "other-project",
      status: "active",
      workspaceId,
    });
    const deployment = rawRecord("agent-deployment", {
      agentDefinitionId: ids[10],
      agentReleaseId: ids[12],
      currentState: "paused",
      desiredState: "paused",
      environmentId,
      id: ids[13],
      organizationId,
      projectId,
    });
    const db = database({
      query: (input) => {
        const values = input.ExpressionAttributeValues as Record<string, unknown>;
        const secondPage = input.ExclusiveStartKey !== undefined;
        if (values[":sk"] === "AGENT-DEFINITION#") {
          return secondPage
            ? { items: [definition, otherProject] }
            : { items: [], lastEvaluatedKey: { cursor: "definitions" } };
        }
        return secondPage
          ? { items: [deployment] }
          : { items: [], lastEvaluatedKey: { cursor: "deployments" } };
      },
    });
    const executor = createRuntimeAgentRegistryBuiltinExecutors(db)["agent.registry.search"];
    const result = await executor(
      {
        ...request,
        input: { status: "paused" },
      },
      {} as never,
    );
    expect(artifactValue(result)).toEqual([
      expect.objectContaining({ id: ids[10], status: "paused", workspaceId }),
    ]);
  });

  test("keeps environment-scoped registry reads out of workspaces", async () => {
    const environmentDefinition = rawRecord("agent-definition", {
      environmentId,
      id: ids[10],
      name: "Environment agent",
      organizationId,
      projectId,
      slug: "environment-agent",
      status: "active",
    });
    const workspaceDefinition = rawRecord("agent-definition", {
      environmentId,
      id: ids[11],
      name: "Workspace agent",
      organizationId,
      projectId,
      slug: "workspace-agent",
      status: "active",
      workspaceId,
    });
    const db = database({
      get: (recordKey) =>
        recordKey.sk === key("AGENT-DEFINITION", ids[11]!) ? workspaceDefinition : undefined,
      query: (input) =>
        (input.ExpressionAttributeValues as Record<string, unknown>)[":sk"] === "AGENT-DEFINITION#"
          ? { items: [environmentDefinition, workspaceDefinition] }
          : { items: [] },
    });
    const registry = createRuntimeAgentRegistryBuiltinExecutors(db);
    const { workspaceId: _workspaceId, ...environmentRequest } = request;
    const search = await registry["agent.registry.search"](environmentRequest, {} as never);
    expect(artifactValue(search)).toEqual([
      expect.objectContaining({ id: ids[10], name: "Environment agent" }),
    ]);
    expect(
      registry["agent.registry.search"](
        { ...environmentRequest, input: { workspaceId } },
        {} as never,
      ),
    ).rejects.toThrow("current run workspace");
    expect(
      registry["agent.registry.get"](
        { ...environmentRequest, input: { agentId: ids[11] }, toolName: "agent.registry.get" },
        {} as never,
      ),
    ).rejects.toThrow("outside the current workspace");
  });

  test("rejects a directly addressed deployment from another project", async () => {
    const targetDeploymentId = ids[10]!;
    const targetDefinitionId = ids[11]!;
    const crossProjectId = ids[19]!;
    const deployment = rawRecord("agent-deployment", {
      agentDefinitionId: targetDefinitionId,
      agentReleaseId: ids[12],
      currentState: "ready",
      desiredState: "running",
      environmentId,
      id: targetDeploymentId,
      organizationId,
      projectId: crossProjectId,
    });
    const definition = rawRecord("agent-definition", {
      environmentId,
      id: targetDefinitionId,
      name: "Cross-project agent",
      organizationId,
      projectId: crossProjectId,
      slug: "cross-project",
      status: "active",
      workspaceId,
    });
    const db = database({
      get: (recordKey) => {
        if (recordKey.sk === key("AGENT-DEPLOYMENT", targetDeploymentId)) return deployment;
        if (recordKey.sk === key("AGENT-DEFINITION", targetDefinitionId)) return definition;
        if (recordKey.sk === key("AGENT-RELEASE", request.agentReleaseId)) return callingRelease;
        return undefined;
      },
    });
    const executor = createRuntimeAgentDelegationBuiltinExecutors({
      database: db,
      enqueueRun: async () => undefined,
      generateId: async () => ids[18]!,
    })["agent.delegate"];
    expect(
      executor(
        {
          ...request,
          effect: "execute",
          input: { prompt: "Investigate", targetAgentId: targetDeploymentId },
          toolName: "agent.delegate",
        },
        {} as never,
      ),
    ).rejects.toThrow("current scope");
  });
});

describe("schedule runtime executors", () => {
  test("uses caller-stable schedule identity across model call indexes", () => {
    const first = scheduleCreationIdempotencyKey({
      ...request,
      idempotencyKey: "model-call-1",
      input: { idempotencyKey: "daily-health" },
      toolName: "agent.schedule.create",
    });
    const second = scheduleCreationIdempotencyKey({
      ...request,
      idempotencyKey: "model-call-2",
      input: { idempotencyKey: "daily-health" },
      toolName: "agent.schedule.create",
    });
    expect(first).toBe(second);
  });

  test("lists only current-agent schedules and rejects archiving another agent's schedule", async () => {
    const current = {
      ...rawRecord("schedule", {
        agentDeploymentId: request.agentDeploymentId,
        createdAt: "2026-07-29T00:00:00.000Z",
        environmentId,
        id: ids[10],
        name: "Current agent",
        organizationId,
        projectId,
        prompt: "Check health",
        schedule: { expression: "rate(1 hour)" },
        status: "active",
        updatedAt: "2026-07-29T00:00:00.000Z",
        workspaceId,
      }),
      gsi2sk: `SCHEDULE#active#2026-07-29T00:00:00.000Z#${ids[10]}`,
    } as PlatformRecord;
    const other = rawRecord("schedule", {
      agentDeploymentId: ids[19],
      createdAt: "2026-07-29T00:00:00.000Z",
      environmentId,
      id: ids[11],
      name: "Other agent",
      organizationId,
      projectId,
      prompt: "Check health",
      schedule: { expression: "rate(2 hours)" },
      status: "active",
      updatedAt: "2026-07-29T00:00:00.000Z",
      workspaceId,
    });
    const otherWorkspace = rawRecord("schedule", {
      ...current.data,
      id: ids[12],
      name: "Other workspace",
      workspaceId: ids[19],
    });
    const db = database({
      get: () => other,
      query: (input) =>
        input.ExclusiveStartKey
          ? { items: [current] }
          : { items: [other, otherWorkspace], lastEvaluatedKey: { cursor: "schedules" } },
    });
    const registry = createRuntimeScheduleBuiltinExecutors({
      database: db,
      generateId: async () => ids[18]!,
      timerProvider: { delete: async () => undefined, upsert: async () => undefined },
    });
    const listed = await registry["agent.schedule.list"](
      { ...request, toolName: "agent.schedule.list" },
      {} as never,
    );
    expect(artifactValue(listed)).toEqual({
      schedules: [expect.objectContaining({ id: ids[10], name: "Current agent" })],
    });
    expect(
      registry["agent.schedule.archive"](
        {
          ...request,
          effect: "write",
          input: { scheduledJobId: ids[11] },
          toolName: "agent.schedule.archive",
        },
        {} as never,
      ),
    ).rejects.toThrow("current agent");
    expect(
      registry["agent.schedule.create"](
        {
          ...request,
          effect: "write",
          input: {
            expression: "not-an-interval",
            kind: "interval",
            name: "Invalid",
            prompt: "Never enqueue this",
          },
          toolName: "agent.schedule.create",
        },
        {} as never,
      ),
    ).rejects.toBeInstanceOf(TypeError);

    const archived = rawRecord("schedule", {
      ...current.data,
      status: "archived",
    });
    const retryingRegistry = createRuntimeScheduleBuiltinExecutors({
      database: database({ get: () => archived }),
      generateId: async () => ids[18]!,
      timerProvider: {
        delete: async () => {
          throw new Error("EventBridge Scheduler is unavailable.");
        },
        upsert: async () => undefined,
      },
    });
    expect(
      retryingRegistry["agent.schedule.archive"](
        {
          ...request,
          effect: "write",
          input: { scheduledJobId: ids[10] },
          toolName: "agent.schedule.archive",
        },
        {} as never,
      ),
    ).rejects.toMatchObject({ name: "RuntimeToolPreparationRetryableError" });
  });
});
