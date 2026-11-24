import { agentManifestContentHash, type AgentResponseFormat } from "@deployments-ai/agent-manifest";
import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  key,
  makeManifestModelAdmission,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
import { semanticEventIsInternal } from "@deployments-ai/events";
import { Schema } from "effect";
import {
  controlFixtures,
  deploymentId,
  environmentId,
  idGenerator,
  ids,
  memoryDatabase,
  now,
  organizationId,
  projectId,
  releaseId,
} from "./conversation-control.fixture.ts";
import {
  DEFAULT_EXECUTION_BINDING_TTL_SECONDS,
  MAX_EXECUTION_BINDING_TTL_SECONDS,
  MIN_EXECUTION_BINDING_TTL_SECONDS,
  createConversationService,
  createEphemeralTurnService,
  createExecutionBindingService,
} from "./index.ts";

const creator = { id: ids[30]!, type: "principal" as const };
const scope = { environmentId, organizationId, projectId };

const releaseFormat: AgentResponseFormat = {
  name: "answer",
  schema: { properties: { answer: { type: "string" } }, required: ["answer"], type: "object" },
  type: "json_schema",
};

function withReleaseFormat(
  release: typeof AgentReleaseRecord.Type,
  responseFormat: AgentResponseFormat,
) {
  const manifest = {
    ...release.data.manifest,
    spec: { ...release.data.manifest.spec, runtime: { responseFormat } },
  };
  return Schema.decodeUnknownSync(AgentReleaseRecord)(
    withCanonicalRecordKeys({
      ...release,
      data: { ...release.data, contentHash: agentManifestContentHash(manifest), manifest },
    }),
  );
}

function setup(
  options: {
    readonly seed?: readonly PlatformRecord[];
    readonly at?: () => Date;
    readonly releaseFormat?: AgentResponseFormat;
  } = {},
) {
  const fixtures = controlFixtures();
  const release = options.releaseFormat
    ? withReleaseFormat(fixtures.release, options.releaseFormat)
    : fixtures.release;
  const memory = memoryDatabase([release, fixtures.deployment, ...(options.seed ?? [])]);
  const enqueued: unknown[] = [];
  const service = {
    admitManifest: makeManifestModelAdmission(memory.database),
    database: memory.database,
    enqueueRun: async (message: unknown) => void enqueued.push(message),
    generateId: idGenerator(),
    now: options.at ?? (() => now),
  };
  return {
    bindings: createExecutionBindingService(service),
    enqueued,
    fixtures,
    memory,
    turns: createEphemeralTurnService(service),
    conversations: createConversationService(service),
  };
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    ...scope,
    createdBy: creator,
    idempotencyKey: "preview-binding-1",
    purpose: "preview" as const,
    source: { agentReleaseId: releaseId, type: "release" as const },
    toolPolicy: "interactive" as const,
    ttlSeconds: DEFAULT_EXECUTION_BINDING_TTL_SECONDS,
    ...overrides,
  };
}

describe("execution binding service", () => {
  test("accepts TTLs from one minute to seven days and defaults to one day", async () => {
    expect(DEFAULT_EXECUTION_BINDING_TTL_SECONDS).toBe(24 * 60 * 60);
    expect(MIN_EXECUTION_BINDING_TTL_SECONDS).toBe(60);
    expect(MAX_EXECUTION_BINDING_TTL_SECONDS).toBe(7 * 24 * 60 * 60);
    const { bindings } = setup();
    for (const ttlSeconds of [59, 7 * 24 * 60 * 60 + 1, 90.5, Number.NaN]) {
      expect(
        bindings.createExecutionBinding(
          createInput({ idempotencyKey: `ttl-${ttlSeconds}`, ttlSeconds }),
        ),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
    for (const ttlSeconds of [60, DEFAULT_EXECUTION_BINDING_TTL_SECONDS, 7 * 24 * 60 * 60]) {
      const { binding } = await bindings.createExecutionBinding(
        createInput({ idempotencyKey: `ttl-${ttlSeconds}`, ttlSeconds }),
      );
      expect(Date.parse(binding.data.expiresAt) - now.getTime()).toBe(ttlSeconds * 1_000);
    }
  });

  test("replays the same request for the same creator and rejects a different payload", async () => {
    const { bindings, memory } = setup();
    const first = await bindings.createExecutionBinding(createInput());
    expect(first).toMatchObject({
      binding: {
        data: {
          purpose: "preview",
          source: { agentReleaseId: releaseId, type: "release" },
          status: "active",
          version: 0,
        },
      },
      created: true,
    });
    const transactionsAfterCreate = memory.transactions.length;

    const replay = await bindings.createExecutionBinding(createInput());
    expect(replay.created).toBe(false);
    expect(replay.binding.data.id).toBe(first.binding.data.id);
    expect(memory.transactions).toHaveLength(transactionsAfterCreate);

    expect(
      bindings.createExecutionBinding(createInput({ toolPolicy: "evaluation" })),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    const otherCreator = await bindings.createExecutionBinding(
      createInput({ createdBy: { id: ids[31]!, type: "principal" } }),
    );
    expect(otherCreator.created).toBe(true);
    expect(otherCreator.binding.data.id).not.toBe(first.binding.data.id);
  });

  test("snapshots runtime config from a deployment without modifying it", async () => {
    const runtimeConfig = {
      apiVersion: "agents.deployments.ai/v1" as const,
      brainRetrievalMode: "off" as const,
      kind: "AgentDeploymentConfig" as const,
    };
    const configured = Schema.decodeUnknownSync(AgentDeploymentRecord)(
      withCanonicalRecordKeys({
        data: {
          ...controlFixtures().deployment.data,
          currentState: "stopped" as const,
          desiredState: "stopped" as const,
          runtimeConfig,
        },
        itemType: "agent-deployment" as const,
      }),
    );
    const { bindings, memory } = setup({ seed: [configured] });

    const { binding } = await bindings.createExecutionBinding(
      createInput({ runtimeConfigFromAgentDeploymentId: deploymentId }),
    );

    expect(binding.data.runtimeConfig).toEqual(runtimeConfig);
    expect(binding.data.runtimeConfigSourceAgentDeploymentId).toBe(deploymentId);
    const stored = memory.records.get(`control\u0000${configured.pk}\u0000${configured.sk}`);
    expect(stored).toEqual(configured);
    expect(
      bindings.createExecutionBinding(
        createInput({
          idempotencyKey: "both-configs",
          runtimeConfig,
          runtimeConfigFromAgentDeploymentId: deploymentId,
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("expiry marks the binding expired with a bumped version", async () => {
    const { bindings } = setup();
    const { binding } = await bindings.createExecutionBinding(createInput());
    const expired = await bindings.expireExecutionBinding({
      ...scope,
      actor: creator,
      executionBindingId: binding.data.id,
    });
    expect(expired.data).toMatchObject({
      expiredAt: now.toISOString(),
      status: "expired",
      version: binding.data.version + 1,
    });
  });
});

describe("ephemeral turns", () => {
  test("starts a bound thread and continues it on the same binding", async () => {
    const { bindings, enqueued, memory, turns } = setup();
    const { binding } = await bindings.createExecutionBinding(createInput());

    const first = await turns.submitEphemeralTurn({
      ...scope,
      actor: creator,
      content: "Preview the agent.",
      executionBindingId: binding.data.id,
      idempotencyKey: "turn-1",
    });
    expect(first.thread.data).toMatchObject({
      channel: "preview",
      executionBindingId: binding.data.id,
      executionPurpose: "preview",
    });
    expect(first.thread.data.agentDeploymentId).toBeUndefined();
    expect(first.run.data).toMatchObject({
      agentReleaseId: releaseId,
      executionBindingId: binding.data.id,
      executionPurpose: "preview",
      queuedAt: "2026-07-23T12:00:00.000Z",
      status: "queued",
      trigger: "preview",
    });
    expect(first.run.data.agentDeploymentId).toBeUndefined();

    const second = await turns.submitEphemeralTurn({
      ...scope,
      actor: creator,
      content: "Continue the preview.",
      executionBindingId: binding.data.id,
      idempotencyKey: "turn-2",
      threadId: first.thread.data.id,
    });
    expect(second.thread.data.id).toBe(first.thread.data.id);
    expect(second.thread.data.version).toBe(first.thread.data.version + 1);
    expect(second.message.data.sequence).toBe(1);
    expect(second.run.data.id).not.toBe(first.run.data.id);
    expect(enqueued).toHaveLength(2);

    const events = [...memory.records.values()].filter(
      (record) =>
        record.itemType === "semantic-event" &&
        (record.data.aggregateId === first.thread.data.id ||
          record.data.aggregateId === first.run.data.id ||
          record.data.aggregateId === second.run.data.id ||
          record.data.aggregateId === binding.data.id),
    );
    expect(
      events.map((record) => record.itemType === "semantic-event" && record.data.eventType),
    ).toEqual(
      expect.arrayContaining([
        "execution-binding.created",
        "user-message.accepted",
        "run.requested",
      ]),
    );
    expect(events).toHaveLength(5);
    expect(
      events.every(
        (record) => record.itemType === "semantic-event" && semanticEventIsInternal(record),
      ),
    ).toBe(true);
  });

  test("rejects continuing a thread owned by another binding", async () => {
    const { bindings, turns } = setup();
    const { binding } = await bindings.createExecutionBinding(createInput());
    const { binding: other } = await bindings.createExecutionBinding(
      createInput({ idempotencyKey: "other-binding" }),
    );
    const first = await turns.submitEphemeralTurn({
      ...scope,
      actor: creator,
      content: "Preview the agent.",
      executionBindingId: binding.data.id,
      idempotencyKey: "turn-1",
    });

    expect(
      turns.submitEphemeralTurn({
        ...scope,
        actor: creator,
        content: "Cross-binding continuation.",
        executionBindingId: other.data.id,
        idempotencyKey: "turn-2",
        threadId: first.thread.data.id,
      }),
    ).rejects.toMatchObject({ code: "scope_mismatch" });
  });

  test("rejects new turns on explicitly and logically expired bindings", async () => {
    let clock = now;
    const { bindings, turns } = setup({ at: () => clock });
    const { binding: explicit } = await bindings.createExecutionBinding(createInput());
    await bindings.expireExecutionBinding({
      ...scope,
      actor: creator,
      executionBindingId: explicit.data.id,
    });
    expect(
      turns.submitEphemeralTurn({
        ...scope,
        actor: creator,
        content: "After expiry.",
        executionBindingId: explicit.data.id,
        idempotencyKey: "turn-expired",
      }),
    ).rejects.toMatchObject({ code: "execution_binding_expired" });

    const { binding: shortLived } = await bindings.createExecutionBinding(
      createInput({ idempotencyKey: "short-lived", ttlSeconds: 60 }),
    );
    clock = new Date(now.getTime() + 60_000);
    expect(
      turns.submitEphemeralTurn({
        ...scope,
        actor: creator,
        content: "After TTL.",
        executionBindingId: shortLived.data.id,
        idempotencyKey: "turn-ttl",
      }),
    ).rejects.toMatchObject({ code: "execution_binding_expired" });
  });

  test("uses the binding purpose as the run trigger for evaluations", async () => {
    const { bindings, turns } = setup();
    const { binding } = await bindings.createExecutionBinding(
      createInput({ purpose: "evaluation", toolPolicy: "evaluation" }),
    );
    const result = await turns.submitEphemeralTurn({
      ...scope,
      actor: creator,
      content: "Evaluate the agent.",
      executionBindingId: binding.data.id,
      idempotencyKey: "eval-1",
    });
    expect(result.run.data).toMatchObject({
      executionPurpose: "evaluation",
      trigger: "evaluation",
    });
    expect(result.thread.data.channel).toBe("evaluation");
  });

  test("partitions bound threads and runs out of the default environment listings", async () => {
    const { bindings, conversations, turns } = setup();
    const { binding } = await bindings.createExecutionBinding(createInput());
    const preview = await turns.submitEphemeralTurn({
      ...scope,
      actor: creator,
      content: "Preview the agent.",
      executionBindingId: binding.data.id,
      idempotencyKey: "turn-1",
    });
    const customer = await conversations.submitTurn({
      ...scope,
      actor: { type: "system" },
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      content: "Customer traffic.",
      idempotencyKey: "customer-1",
    });

    const bindingPartition = key("ENV", environmentId, "EXECUTION-BINDING", binding.data.id);
    expect(preview.thread.gsi2pk).toBe(bindingPartition);
    expect(preview.run.gsi2pk).toBe(bindingPartition);
    expect(customer.thread.gsi2pk).toBe(key("ENV", environmentId));
    expect(customer.run.gsi2pk).toBe(key("ENV", environmentId, "AGENT-DEPLOYMENT", deploymentId));
  });

  test("persists the pinned release format when the turn does not request one", async () => {
    const { bindings, turns } = setup({ releaseFormat });
    const { binding } = await bindings.createExecutionBinding(
      createInput({ purpose: "evaluation", toolPolicy: "evaluation" }),
    );
    const result = await turns.submitEphemeralTurn({
      ...scope,
      actor: creator,
      content: "Evaluate the agent.",
      executionBindingId: binding.data.id,
      idempotencyKey: "eval-format",
    });
    expect(result.run.data.responseFormat).toEqual(releaseFormat);
  });

  test("rejects a request format that conflicts with the pinned release format", async () => {
    const { bindings, memory, turns } = setup({ releaseFormat });
    const { binding } = await bindings.createExecutionBinding(createInput());
    const transactionsBefore = memory.transactions.length;
    expect(
      turns.submitEphemeralTurn({
        ...scope,
        actor: creator,
        content: "Preview the agent.",
        executionBindingId: binding.data.id,
        idempotencyKey: "conflicting-format",
        responseFormat: { ...releaseFormat, schema: { type: "array" } },
      }),
    ).rejects.toMatchObject({ code: "response_format_conflict" });
    expect(memory.transactions).toHaveLength(transactionsBefore);
  });

  test("persists the request format when the release pins none", async () => {
    const { bindings, turns } = setup();
    const { binding } = await bindings.createExecutionBinding(createInput());
    const result = await turns.submitEphemeralTurn({
      ...scope,
      actor: creator,
      content: "Preview the agent.",
      executionBindingId: binding.data.id,
      idempotencyKey: "request-format",
      responseFormat: releaseFormat,
    });
    expect(result.run.data.responseFormat).toEqual(releaseFormat);
  });
});
