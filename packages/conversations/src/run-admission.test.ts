import {
  HoldKey,
  StandingActor,
  WorkspaceRecord,
  withCanonicalRecordKeys,
  makeManifestModelAdmission,
  makeOrganizationStandingRepository,
  type DynamoDatabaseService,
  type HoldReason,
  type Ulid,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  controlFixtures,
  deploymentId,
  environmentId,
  exhaustedBudget,
  idGenerator,
  ids,
  memoryDatabase,
  now,
  organizationId,
  projectId,
  releaseId,
  workspaceId,
} from "./conversation-control.fixture.ts";
import {
  DEFAULT_EXECUTION_BINDING_TTL_SECONDS,
  createConversationService,
  createEphemeralTurnService,
  createExecutionBindingService,
} from "./index.ts";

const OPERATOR = Schema.decodeUnknownSync(StandingActor)({
  kind: "operator",
  principalId: "01J9ZQ5Y5V7Q8R3X2K4M6N8P0B",
});
const HOLD = { actor: OPERATOR, key: Schema.decodeUnknownSync(HoldKey)("review"), organizationId };

function standingOver(database: DynamoDatabaseService) {
  const standing = makeOrganizationStandingRepository({
    database,
    installDefaults: {
      operatorFundedModelSpendCeiling: "unlimited",
      tenantLimits: {
        activeSandboxes: 1,
        apiRequestBurst: 40,
        apiRequestsPerSecond: 20,
        concurrentRuns: 2,
      },
    },
  });
  return {
    hold: (reason: HoldReason) =>
      standing.placeHold({ ...HOLD, customerMessage: "Held for review.", reason }),
    release: () => standing.releaseHold(HOLD),
  };
}

const scope = { environmentId, organizationId, projectId };

function setup(seed: Parameters<typeof memoryDatabase>[0] = []) {
  const fixtures = controlFixtures();
  const memory = memoryDatabase([fixtures.deployment, fixtures.release, ...seed]);
  const enqueued: unknown[] = [];
  const options = {
    admitManifest: makeManifestModelAdmission(memory.database),
    database: memory.database,
    enqueueRun: async (message: unknown) => void enqueued.push(message),
    generateId: idGenerator(),
    now: () => now,
  };
  return {
    bindings: createExecutionBindingService(options),
    conversations: createConversationService(options),
    enqueued,
    memory,
    turns: createEphemeralTurnService(options),
  };
}

const turn = (idempotencyKey: string) => ({
  ...scope,
  actor: { type: "system" as const },
  agentDeploymentId: deploymentId,
  agentReleaseId: releaseId,
  content: "Summarize the account.",
  idempotencyKey,
});

const SIBLING_WORKSPACE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FW2" as Ulid;

function siblingWorkspace() {
  return Schema.decodeUnknownSync(WorkspaceRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: now.toISOString(),
        environmentId,
        id: SIBLING_WORKSPACE_ID,
        name: "Sibling workspace",
        organizationId,
        projectId,
        slug: "sibling-workspace",
        status: "active" as const,
        updatedAt: now.toISOString(),
        version: 0,
      },
      itemType: "workspace" as const,
    }),
  );
}

async function admission(submission: Promise<unknown>) {
  return submission.then(
    () => "admitted",
    (cause: { readonly code: string }) => cause.code,
  );
}

describe("budget admission", () => {
  for (const level of ["workspace", "environment", "project", "organization"] as const) {
    test(`refuses a new run while an active ${level} budget is exhausted`, async () => {
      const exhausted = exhaustedBudget(level, { name: `Team ${level}` });
      const { conversations, enqueued, memory } = setup(exhausted.records);

      const refusal = conversations.submitTurn({ ...turn(`refused-${level}`), workspaceId });

      expect(refusal).rejects.toMatchObject({
        code: "budget_exhausted",
        name: "ConversationError",
      });
      const message = await refusal.catch((cause: Error) => cause.message);
      expect(message).toBe(
        `Budget "Team ${level}" (${exhausted.budget.data.id}) for the ${level} has reached 100% ` +
          `of its monthly limit for the period starting ${exhausted.periodStart}; new runs are ` +
          "refused until the period ends or the budget is raised, paused, or archived.",
      );
      expect(exhausted.periodStart).toBe("2026-07-01T00:00:00.000Z");
      expect(enqueued).toHaveLength(0);
      expect(memory.transactions).toHaveLength(0);
    });
  }

  test("refuses a follow-up turn that inherits its thread's exhausted workspace", async () => {
    const { conversations, enqueued, memory } = setup([siblingWorkspace()]);
    const first = await conversations.submitTurn({ ...turn("workspace-thread"), workspaceId });
    expect(first.thread.data.workspaceId).toBe(workspaceId);
    for (const record of exhaustedBudget("workspace").records) memory.put(record);

    const followUp = await admission(
      conversations.submitTurn({ ...turn("workspace-follow-up"), threadId: first.thread.data.id }),
    );
    const sibling = await admission(
      conversations.submitTurn({ ...turn("sibling-workspace"), workspaceId: SIBLING_WORKSPACE_ID }),
    );
    const outsideWorkspaces = await admission(conversations.submitTurn(turn("no-workspace")));

    expect([followUp, sibling, outsideWorkspaces]).toEqual([
      "budget_exhausted",
      "admitted",
      "admitted",
    ]);
    expect(enqueued).toHaveLength(3);
  });

  test("refuses an ephemeral follow-up that inherits its thread's exhausted workspace", async () => {
    const { bindings, memory, turns } = setup();
    const { binding } = await bindings.createExecutionBinding({
      ...scope,
      createdBy: { id: ids[30]!, type: "principal" },
      idempotencyKey: "workspace-preview-binding",
      purpose: "preview",
      source: { agentReleaseId: releaseId, type: "release" },
      toolPolicy: "interactive",
      ttlSeconds: DEFAULT_EXECUTION_BINDING_TTL_SECONDS,
    });
    const previewTurn = (idempotencyKey: string) => ({
      ...scope,
      actor: { id: ids[30]!, type: "principal" as const },
      content: "Preview the agent.",
      executionBindingId: binding.data.id,
      idempotencyKey,
    });
    const first = await turns.submitEphemeralTurn({
      ...previewTurn("workspace-preview"),
      workspaceId,
    });
    expect(first.thread.data.workspaceId).toBe(workspaceId);
    for (const record of exhaustedBudget("workspace").records) memory.put(record);

    expect(
      await admission(
        turns.submitEphemeralTurn({
          ...previewTurn("workspace-preview-follow-up"),
          threadId: first.thread.data.id,
        }),
      ),
    ).toBe("budget_exhausted");
    expect(await admission(turns.submitEphemeralTurn(previewTurn("no-workspace-preview")))).toBe(
      "admitted",
    );
  });

  for (const status of ["paused", "archived"] as const) {
    test(`admits runs when the exhausted budget is ${status}`, async () => {
      const { conversations, enqueued } = setup(exhaustedBudget("environment", { status }).records);

      const result = await conversations.submitTurn(turn(`admitted-${status}`));

      expect(result.created).toBe(true);
      expect(result.run.data.status).toBe("queued");
      expect(enqueued).toHaveLength(1);
    });
  }

  test("replays an already admitted submission after its budget is exhausted", async () => {
    const { conversations, enqueued, memory } = setup();
    const first = await conversations.submitTurn(turn("admitted-before-exhaustion"));
    for (const record of exhaustedBudget("organization").records) memory.put(record);

    const replayed = await conversations.submitTurn(turn("admitted-before-exhaustion"));

    expect(replayed.created).toBe(false);
    expect(replayed.run.data.id).toBe(first.run.data.id);
    expect(enqueued).toHaveLength(2);
    expect(conversations.submitTurn(turn("after-exhaustion"))).rejects.toMatchObject({
      code: "budget_exhausted",
    });
    expect(memory.transactions).toHaveLength(1);
  });

  test("refuses ephemeral preview and evaluation turns while a budget is exhausted", async () => {
    const { bindings, enqueued, memory, turns } = setup();
    const { binding } = await bindings.createExecutionBinding({
      ...scope,
      createdBy: { id: ids[30]!, type: "principal" },
      idempotencyKey: "budget-preview-binding",
      purpose: "preview",
      source: { agentReleaseId: releaseId, type: "release" },
      toolPolicy: "interactive",
      ttlSeconds: DEFAULT_EXECUTION_BINDING_TTL_SECONDS,
    });
    const transactionsBeforeTurn = memory.transactions.length;
    for (const record of exhaustedBudget("project").records) memory.put(record);

    expect(
      turns.submitEphemeralTurn({
        ...scope,
        actor: { id: ids[30]!, type: "principal" },
        content: "Preview the agent.",
        executionBindingId: binding.data.id,
        idempotencyKey: "budget-preview-turn",
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(enqueued).toHaveLength(0);
    expect(memory.transactions).toHaveLength(transactionsBeforeTurn);
  });
});

describe("standing admission", () => {
  for (const reason of ["payment", "abuse"] as const) {
    test(`refuses a new turn while the organization is suspended for ${reason}`, async () => {
      const { conversations, enqueued, memory } = setup();
      await standingOver(memory.database).hold(reason);
      const transactionsBeforeTurn = memory.transactions.length;

      const refusal = conversations.submitTurn(turn(`suspended-${reason}`));

      expect(refusal).rejects.toMatchObject({
        code: "organization_suspended",
        message:
          "The organization is suspended; new runs are refused until every hold is released.",
        name: "ConversationError",
      });
      await refusal.catch(() => undefined);
      expect(enqueued).toHaveLength(0);
      expect(memory.transactions).toHaveLength(transactionsBeforeTurn);
    });
  }

  test("refuses ephemeral preview and evaluation turns while the organization is suspended", async () => {
    const { bindings, enqueued, memory, turns } = setup();
    const { binding } = await bindings.createExecutionBinding({
      ...scope,
      createdBy: { id: ids[30]!, type: "principal" },
      idempotencyKey: "suspended-preview-binding",
      purpose: "preview",
      source: { agentReleaseId: releaseId, type: "release" },
      toolPolicy: "interactive",
      ttlSeconds: DEFAULT_EXECUTION_BINDING_TTL_SECONDS,
    });
    await standingOver(memory.database).hold("policy");
    const transactionsBeforeTurn = memory.transactions.length;

    const refusal = turns.submitEphemeralTurn({
      ...scope,
      actor: { id: ids[30]!, type: "principal" },
      content: "Preview the agent.",
      executionBindingId: binding.data.id,
      idempotencyKey: "suspended-preview-turn",
    });

    expect(refusal).rejects.toMatchObject({ code: "organization_suspended" });
    await refusal.catch(() => undefined);
    expect(enqueued).toHaveLength(0);
    expect(memory.transactions).toHaveLength(transactionsBeforeTurn);
  });

  test("admits a new turn once every hold is released", async () => {
    const { conversations, enqueued, memory } = setup();
    const standing = standingOver(memory.database);
    await standing.hold("abuse");
    const whileHeld = await conversations.submitTurn(turn("held-then-released")).then(
      () => "admitted",
      (cause: { code: string }) => cause.code,
    );
    await standing.release();

    const released = await conversations.submitTurn(turn("held-then-released"));

    expect([whileHeld, released.created, released.run.data.status]).toEqual([
      "organization_suspended",
      true,
      "queued",
    ]);
    expect(enqueued).toHaveLength(1);
  });

  test("refuses with a retryable code, not a suspension, when standing cannot be read", async () => {
    const { memory } = setup();
    const conversations = createConversationService({
      database: {
        ...memory.database,
        getRecord: async (table, key) => {
          if (key.sk === "ORGANIZATION-STANDING") throw new Error("DynamoDB is unavailable.");
          return memory.database.getRecord(table, key);
        },
      },
      enqueueRun: async () => undefined,
      generateId: idGenerator(),
      now: () => now,
    });

    expect(conversations.submitTurn(turn("standing-unreadable"))).rejects.toMatchObject({
      code: "organization_standing_unavailable",
      message: "The organization's standing could not be read; retry the request.",
    });
  });
});
