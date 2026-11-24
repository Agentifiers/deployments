import { AutomationError } from "@deployments-ai/automations";
import { ConversationError } from "@deployments-ai/conversations";
import {
  BudgetRecord,
  HoldKey,
  MessageRecord,
  RunRecord,
  ScopeSpendShardRecord,
  StandingActor,
  ThreadRecord,
  budgetPeriodBounds,
  makeOrganizationStandingRepository,
  withCanonicalRecordKeys,
  type HoldReason,
  type PlatformRecord,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { replayRun, retryRun } from "./runtime-operations.ts";
import {
  automationSubmission,
  problem,
  runtimeApiErrorFromCause,
  type RuntimeApiDependencies,
} from "./runtime-support.ts";
import {
  deployment,
  environmentId,
  ids,
  memoryDatabase,
  now,
  organizationId,
  principal,
  projectId,
  release,
  runLocator,
  runRecord,
  serviceAccountId,
} from "./runtime-lifecycle.fixture.ts";

type SourceRun = typeof RunRecord.Type;

function threadRecord(run: SourceRun) {
  return Schema.decodeUnknownSync(ThreadRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: run.data.agentDeploymentId,
        archived: false,
        channel: "api",
        createdAt: now.toISOString(),
        createdBy: { id: serviceAccountId, type: "service-account" as const },
        environmentId,
        id: run.data.threadId,
        organizationId,
        pinned: false,
        projectId,
        streamId: ids[18]!,
        title: "Budget source",
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "thread" as const,
    }),
  );
}

function promptMessage(run: SourceRun) {
  return Schema.decodeUnknownSync(MessageRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: run.data.agentDeploymentId,
        body: "Replay this prompt",
        contentHash: "source-content-hash",
        createdAt: now.toISOString(),
        environmentId,
        id: run.data.userMessageId!,
        organizationId,
        projectId,
        role: "user" as const,
        runId: run.data.id,
        sequence: run.data.userMessageSequence!,
        threadId: run.data.threadId,
      },
      itemType: "message" as const,
    }),
  );
}

/** An active organization budget whose current monthly spend equals its amount. */
function exhaustedOrganizationBudget() {
  const budget = Schema.decodeUnknownSync(BudgetRecord)(
    withCanonicalRecordKeys({
      data: {
        amountUsdMicros: 1_000_000,
        createdAt: now.toISOString(),
        id: ids[30]!,
        name: "Org monthly",
        organizationId,
        period: "monthly" as const,
        scope: "organization" as const,
        status: "active" as const,
        thresholds: [50, 80, 100],
        updatedAt: now.toISOString(),
        version: 1,
      },
      itemType: "budget" as const,
    }),
  );
  const shard = Schema.decodeUnknownSync(ScopeSpendShardRecord)(
    withCanonicalRecordKeys({
      data: {
        organizationId,
        period: "monthly" as const,
        periodStart: budgetPeriodBounds("monthly", now).periodStart,
        scope: "organization" as const,
        shard: 0,
        spendUsdMicros: 1_000_000,
        updatedAt: now.toISOString(),
        version: 1,
      },
      itemType: "scope-spend-shard" as const,
    }),
  );
  return [budget, shard] as const;
}

function setup(
  run: SourceRun,
  admission: readonly PlatformRecord[] = exhaustedOrganizationBudget(),
) {
  const memory = memoryDatabase([
    run,
    runLocator(run),
    threadRecord(run),
    promptMessage(run),
    deployment(),
    release(),
    ...admission,
  ]);
  const generated = ids.slice(20, 28);
  const dependencies = {
    database: memory.database,
    enqueueRun: async () => undefined,
    generateId: async () => generated.shift()!,
    now: () => now,
  } as unknown as RuntimeApiDependencies;
  return { dependencies, memory };
}

const detail =
  `Budget "Org monthly" (${ids[30]}) for the organization has reached 100% of its monthly ` +
  "limit for the period starting 2026-07-01T00:00:00.000Z; new runs are refused until the " +
  "period ends or the budget is raised, paused, or archived.";

describe("budget admission for run mutations", () => {
  test("refuses replay while an organization budget is exhausted", async () => {
    const { dependencies, memory } = setup(runRecord("completed"));

    expect(replayRun(dependencies, principal(), ids[7]!, "budget-replay")).rejects.toMatchObject({
      code: "budget_exhausted",
      message: detail,
    });
    expect(memory.transactions).toHaveLength(0);
  });

  test("refuses retry while an organization budget is exhausted", async () => {
    const { dependencies, memory } = setup(runRecord("failed"));

    expect(retryRun(dependencies, principal(), ids[7]!)).rejects.toMatchObject({
      code: "budget_exhausted",
      message: detail,
    });
    expect(memory.transactions).toHaveLength(0);
  });

  test("maps a budget refusal to 429 with the budget named in the problem detail", () => {
    const response = problem(
      runtimeApiErrorFromCause(new ConversationError("budget_exhausted", detail)),
      "request-1",
    );

    expect(response.statusCode).toBe(429);
    expect(JSON.parse(response.body)).toMatchObject({
      code: "budget_exhausted",
      detail,
      requestId: "request-1",
      status: 429,
    });
  });

  test("hands automation fires a budget refusal as an automation skip", async () => {
    const refusal = await automationSubmission(
      Promise.reject(new ConversationError("budget_exhausted", detail)),
    ).catch((cause: unknown) => cause);
    expect(refusal).toBeInstanceOf(AutomationError);
    expect(refusal).toMatchObject({ code: "budget_exhausted", message: detail });
    const unavailable = new ConversationError("deployment_unavailable", "Not runnable.");
    expect(automationSubmission(Promise.reject(unavailable))).rejects.toBe(unavailable);
  });
});

async function suspended(run: SourceRun, reason: HoldReason) {
  const { dependencies, memory } = setup(run, []);
  await makeOrganizationStandingRepository({
    database: memory.database,
    installDefaults: {
      operatorFundedModelSpendCeiling: "unlimited",
      tenantLimits: {
        activeSandboxes: 1,
        apiRequestBurst: 40,
        apiRequestsPerSecond: 20,
        concurrentRuns: 2,
      },
    },
  }).placeHold({
    actor: Schema.decodeUnknownSync(StandingActor)({
      kind: "operator",
      principalId: "01J9ZQ5Y5V7Q8R3X2K4M6N8P0B",
    }),
    customerMessage: "Held for review.",
    key: Schema.decodeUnknownSync(HoldKey)("review"),
    organizationId,
    reason,
  });
  return { dependencies, memory, transactionsBefore: memory.transactions.length };
}

const suspendedDetail =
  "The organization is suspended; new runs are refused until every hold is released.";

describe("standing admission for run mutations", () => {
  test("refuses replay while an abuse hold suspends the organization", async () => {
    const { dependencies, memory, transactionsBefore } = await suspended(
      runRecord("completed"),
      "abuse",
    );

    expect(replayRun(dependencies, principal(), ids[7]!, "suspended-replay")).rejects.toMatchObject(
      { code: "organization_suspended", message: suspendedDetail },
    );
    expect(memory.transactions).toHaveLength(transactionsBefore);
  });

  test("refuses retry while a payment hold suspends the organization", async () => {
    const { dependencies, memory, transactionsBefore } = await suspended(
      runRecord("failed"),
      "payment",
    );

    expect(retryRun(dependencies, principal(), ids[7]!)).rejects.toMatchObject({
      code: "organization_suspended",
      message: suspendedDetail,
    });
    expect(memory.transactions).toHaveLength(transactionsBefore);
  });

  test("maps a suspension to 403 and an unreadable standing to a retryable 503", () => {
    const statuses = [
      new ConversationError("organization_suspended", suspendedDetail),
      new ConversationError("organization_standing_unavailable", "Standing could not be read."),
    ].map((cause) => {
      const response = problem(runtimeApiErrorFromCause(cause), "request-1");
      const body = JSON.parse(response.body) as { readonly code: string; readonly detail: string };
      return [response.statusCode, body.code, body.detail];
    });

    expect(statuses).toEqual([
      [403, "organization_suspended", suspendedDetail],
      [503, "organization_standing_unavailable", "Internal server error."],
    ]);
  });

  test("hands automation fires a suspension as an automation skip", async () => {
    const refusal = await automationSubmission(
      Promise.reject(new ConversationError("organization_suspended", suspendedDetail)),
    ).catch((cause: unknown) => cause);

    expect(refusal).toBeInstanceOf(AutomationError);
    expect(refusal).toMatchObject({ code: "organization_suspended", message: suspendedDetail });
  });

  test("leaves an unreadable standing retryable for automation fires instead of a skip", async () => {
    const unavailable = new ConversationError(
      "organization_standing_unavailable",
      "Standing could not be read.",
    );

    const failure = await automationSubmission(Promise.reject(unavailable)).catch(
      (cause: unknown) => cause,
    );
    const response = problem(runtimeApiErrorFromCause(failure), "request-1");

    expect([failure === unavailable, response.statusCode]).toEqual([true, 503]);
  });
});
