import { agentManifestContentHash } from "@deployments-ai/agent-manifest";
import {
  AgentReleaseRecord,
  ArtifactRecord,
  key,
  ThreadRecord,
  withCanonicalRecordKeys,
  WorkspaceRecord,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import { describe, expect, test } from "bun:test";
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
  workspaceId,
} from "./conversation-control.fixture.ts";
import {
  createConversationService,
  readConversationHistory,
  transientConversationMessageMetadata,
} from "./index.ts";

describe("conversation control plane", () => {
  test("freezes private attachment IDs on their user message and run across idempotent submission", async () => {
    const fixtures = controlFixtures();
    const actor = { id: ids[23]!, type: "service-account" as const };
    const thread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        itemType: "thread",
        data: {
          organizationId,
          projectId,
          environmentId,
          id: ids[21]!,
          agentDeploymentId: deploymentId,
          archived: false,
          pinned: false,
          channel: "api",
          title: "Media thread",
          streamId: ids[25]!,
          createdBy: actor,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          version: 0,
        },
      }),
    );
    const artifact = Schema.decodeUnknownSync(ArtifactRecord)(
      withCanonicalRecordKeys({
        itemType: "artifact",
        data: {
          organizationId,
          projectId,
          environmentId,
          id: ids[22]!,
          threadId: thread.data.id,
          owner: { serviceAccountId: actor.id, type: "service-account" },
          visibility: "private",
          status: "available",
          name: "frame.jpg",
          type: "input",
          input: { kind: "image", mediaType: "image/jpeg" },
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          version: 0,
          storage: {
            bucket: "private",
            key: "frame",
            contentType: "image/jpeg",
            byteSize: 100,
            sha256: "a".repeat(64),
            versionId: "v1",
          },
        },
      }),
    );
    const memory = memoryDatabase([fixtures.deployment, fixtures.release, thread, artifact]);
    const service = createConversationService({
      database: memory.database,
      generateId: idGenerator(),
      now: () => now,
      enqueueRun: async () => {},
    });
    const submitted = {
      actor,
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      organizationId,
      projectId,
      environmentId,
      content: "Describe the frame",
      threadId: thread.data.id,
      idempotencyKey: "private-frame",
      initiatingCaller: {
        type: "service-account" as const,
        serviceAccountId: actor.id,
        apiCredentialId: ids[24]!,
      },
      inputArtifacts: [artifact.data.id],
      responseFormat: {
        type: "json_schema" as const,
        name: "description",
        schema: { type: "object" },
      },
    };
    const first = await service.submitTurn(submitted);
    const repeated = await service.submitTurn(submitted);
    expect(first.message.data.inputArtifacts).toEqual([artifact.data.id]);
    expect(repeated.run.data.inputArtifacts).toEqual(first.run.data.inputArtifacts);
    expect(repeated.message.data.id).toBe(first.message.data.id);
    expect(service.submitTurn({ ...submitted, inputArtifacts: [ids[26]!] })).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
    expect(
      service.submitTurn({
        ...submitted,
        idempotencyKey: "another-caller",
        actor: { ...actor, id: ids[27]! },
        initiatingCaller: { ...submitted.initiatingCaller, serviceAccountId: ids[27]! },
      }),
    ).rejects.toMatchObject({ code: "input_artifact_unavailable" });
  });

  test("rejects a submission whose trigger is not declared by the release", async () => {
    const fixtures = controlFixtures();
    const manifest = {
      ...fixtures.release.data.manifest,
      spec: {
        ...fixtures.release.data.manifest.spec,
        triggers: ["schedule" as const],
      },
    };
    const release = Schema.decodeUnknownSync(AgentReleaseRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixtures.release.data,
          contentHash: agentManifestContentHash(manifest),
          manifest,
        },
        itemType: "agent-release" as const,
      }),
    );
    const memory = memoryDatabase([fixtures.deployment, release]);
    let enqueues = 0;
    const service = createConversationService({
      database: memory.database,
      enqueueRun: async () => void (enqueues += 1),
      generateId: idGenerator(),
      now: () => now,
    });

    expect(
      service.submitTurn({
        actor: { type: "system" },
        agentDeploymentId: deploymentId,
        agentReleaseId: releaseId,
        content: "Run through the API.",
        environmentId,
        idempotencyKey: "disallowed-trigger",
        organizationId,
        projectId,
      }),
    ).rejects.toMatchObject({ code: "trigger_not_allowed" });
    expect(enqueues).toBe(0);
    expect(memory.transactions).toHaveLength(0);
  });

  test("rejects a workspace-memory submission without a workspace before persisting it", async () => {
    const fixtures = controlFixtures();
    const manifest = {
      ...fixtures.release.data.manifest,
      spec: { ...fixtures.release.data.manifest.spec, memory: { mode: "workspace" as const } },
    };
    const release = Schema.decodeUnknownSync(AgentReleaseRecord)(
      withCanonicalRecordKeys({
        data: {
          ...fixtures.release.data,
          contentHash: agentManifestContentHash(manifest),
          manifest,
        },
        itemType: "agent-release" as const,
      }),
    );
    const memory = memoryDatabase([fixtures.deployment, release]);
    let enqueues = 0;
    const service = createConversationService({
      database: memory.database,
      enqueueRun: async () => void (enqueues += 1),
      generateId: idGenerator(),
      now: () => now,
    });
    const submission = {
      actor: { type: "system" as const },
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      content: "Remember this.",
      environmentId,
      organizationId,
      projectId,
    };

    expect(
      service.submitTurn({ ...submission, idempotencyKey: "workspace-memory-no-workspace" }),
    ).rejects.toMatchObject({ code: "workspace_required" });
    expect(enqueues).toBe(0);
    expect(memory.transactions).toHaveLength(0);

    const accepted = await service.submitTurn({
      ...submission,
      idempotencyKey: "workspace-memory-with-workspace",
      workspaceId,
    });
    expect(accepted.run.data.workspaceId).toBe(workspaceId);
    expect(enqueues).toBe(1);
  });

  test("persists and enqueues the first turn once, then replays it idempotently", async () => {
    const fixtures = controlFixtures();
    const memory = memoryDatabase([fixtures.deployment, fixtures.release]);
    const enqueued: unknown[] = [];
    const appended: unknown[] = [];
    const service = createConversationService({
      appendThreadEvent: async (event) => {
        appended.push(event);
      },
      database: memory.database,
      enqueueRun: async (input) => {
        enqueued.push(input);
      },
      generateId: idGenerator(),
      now: () => now,
    });
    const input = {
      actor: { id: ids[7]!, type: "principal" as const },
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      content: "Ship the runtime",
      environmentId,
      idempotencyKey: "request-123",
      initiatingCaller: {
        principalId: ids[7]!,
        scopes: ["brains:read"],
        type: "principal" as const,
      },
      organizationId,
      projectId,
      responsePublication: "external" as const,
      runContext: "Authoritative per-run state snapshot",
      responseFormat: { type: "json_schema" as const, name: "result", schema: { type: "object" } },
      workspaceId,
    };

    const created = await service.submitTurn(input);
    const replayed = await service.submitTurn(input);
    expect(
      service.submitTurn({ ...input, runContext: "Different per-run state snapshot" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(
      service.submitTurn({
        ...input,
        responseFormat: { ...input.responseFormat, schema: { type: "array" } },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const { responsePublication: _responsePublication, ...immediateInput } = input;
    expect(service.submitTurn(immediateInput)).rejects.toMatchObject({
      code: "idempotency_conflict",
    });

    expect(created.created).toBe(true);
    expect(created.thread.data.version).toBe(0);
    expect(created.message.data.sequence).toBe(0);
    expect(created.message.data.runId).toBe(created.run.data.id);
    expect(created.run.data.userMessageId).toBe(created.message.data.id);
    expect(created.run.data.userMessageSequence).toBe(0);
    expect(created.run.data.runContext).toBe("Authoritative per-run state snapshot");
    expect(created.run.data.responsePublication).toBe("external");
    expect(replayed.run.data.responseFormat).toEqual(input.responseFormat);
    expect(created.message.data.body).toBe("Ship the runtime");
    expect(created.message.data.metadata).toBeUndefined();
    expect(created.run.data.initiatingCaller).toEqual({
      principalId: ids[7]!,
      scopes: ["brains:read"],
      type: "principal",
    });
    expect(created.run.data.traceId).toHaveLength(32);
    expect(created.run.data.spanId).toHaveLength(16);
    expect(created.queueMessage).toMatchObject({
      runId: created.run.data.id,
      threadId: created.thread.data.id,
      userMessageId: created.message.data.id,
      userMessageSequence: 0,
    });
    expect(replayed.created).toBe(false);
    expect(replayed.run.data.id).toBe(created.run.data.id);
    expect(memory.transactions).toHaveLength(1);
    expect(memory.transactions[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "put",
          record: expect.objectContaining({
            data: expect.objectContaining({
              rootRunId: created.run.data.id,
              rootSpanId: created.run.data.spanId,
              traceId: created.run.data.traceId,
            }),
            itemType: "trace",
          }),
        }),
      ]),
    );
    expect(enqueued).toHaveLength(2);
    expect(appended).toHaveLength(2);
    expect(appended).toEqual([
      expect.objectContaining({ actor: { id: ids[7]!, type: "user" } }),
      expect.objectContaining({ actor: { id: ids[7]!, type: "user" } }),
    ]);
    const idempotency = memory.transactions[0]?.find(
      (
        operation,
      ): operation is Extract<TransactionOperation, { readonly kind: "put" }> & {
        readonly record: Extract<PlatformRecord, { readonly itemType: "idempotency" }>;
      } => operation.kind === "put" && operation.record.itemType === "idempotency",
    );
    expect(idempotency?.record.data.expiresAt).toBe("9999-12-31T23:59:59.999Z");
    expect(enqueued[0]).toMatchObject({
      deduplicationId: created.run.data.id,
      messageGroupId: `${organizationId}:${projectId}:${environmentId}:${created.thread.data.id}`,
    });
    expect(memory.transactions[0]).toContainEqual(
      expect.objectContaining({
        expressionAttributeValues: { ":active": "active", ":version": 0 },
        key: { pk: `ORG#${organizationId}#ENV#${environmentId}`, sk: `WORKSPACE#${workspaceId}` },
        kind: "condition-check",
        table: "control",
      }),
    );
    expect(
      memory.transactions[0]?.filter(
        (operation) => operation.kind === "put" && operation.record.itemType === "semantic-event",
      ),
    ).toHaveLength(2);
    expect(
      memory.transactions[0]?.find(
        (operation) =>
          operation.kind === "put" &&
          operation.record.itemType === "semantic-event" &&
          operation.record.data.eventType === "run.requested",
      ),
    ).toMatchObject({
      record: {
        data: {
          payload: {
            idempotencyKey: "request-123",
            threadId: created.thread.data.id,
            userMessageId: created.message.data.id,
            userMessageSequence: 0,
          },
        },
      },
    });
  });

  test("does not publish transient automation prompts to the live thread stream", async () => {
    const fixtures = controlFixtures();
    const memory = memoryDatabase([fixtures.deployment, fixtures.release]);
    const enqueued: unknown[] = [];
    const appended: unknown[] = [];
    const service = createConversationService({
      appendThreadEvent: async (event) => {
        appended.push(event);
      },
      database: memory.database,
      enqueueRun: async (input) => {
        enqueued.push(input);
      },
      generateId: idGenerator(),
      now: () => now,
    });
    const input = {
      actor: { type: "system" as const },
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      content: "Evaluate whether to initiate a conversation.",
      environmentId,
      idempotencyKey: "transient-heartbeat-prompt",
      messageMetadata: transientConversationMessageMetadata(),
      organizationId,
      projectId,
      trigger: "heartbeat",
    };

    await service.submitTurn(input);
    await service.submitTurn(input);

    expect(enqueued).toHaveLength(2);
    expect(appended).toEqual([]);
    expect(
      memory.transactions[0]
        ?.filter(
          (
            operation,
          ): operation is Extract<TransactionOperation, { readonly kind: "put" }> & {
            readonly record: Extract<PlatformRecord, { readonly itemType: "semantic-event" }>;
          } => operation.kind === "put" && operation.record.itemType === "semantic-event",
        )
        .map((operation) => ({
          eventType: operation.record.data.eventType,
          payload: operation.record.data.payload,
        })),
    ).toEqual([
      {
        eventType: "user-message.accepted",
        payload: expect.objectContaining({ deploymentsAiInternal: true }),
      },
      { eventType: "run.requested", payload: expect.any(Object) },
    ]);
  });

  test("persists external thread identity and metadata and rejects route corruption", async () => {
    const fixtures = controlFixtures();
    const memory = memoryDatabase([fixtures.deployment, fixtures.release]);
    const service = createConversationService({
      database: memory.database,
      enqueueRun: async () => {},
      generateId: idGenerator(),
      now: () => now,
    });
    const threadId = ids[30]!;
    const created = await service.submitTurn({
      actor: { type: "system" },
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      channel: "telegram",
      content: "Inbound channel message",
      createThreadIfMissing: true,
      environmentId,
      externalThreadKey: "telegram-chat-1",
      idempotencyKey: "channel-message-1",
      messageMetadata: {
        externalMessageId: "telegram-message-1",
        sender: { id: "telegram-user-1" },
      },
      organizationId,
      projectId,
      threadId,
      trigger: "chat",
    });

    expect(created.thread.data.id).toBe(threadId);
    expect(created.thread.data.externalThreadKey).toBe("telegram-chat-1");
    expect(created.message.data.metadata).toEqual({
      externalMessageId: "telegram-message-1",
      sender: { id: "telegram-user-1" },
    });
    expect(
      service.submitTurn({
        actor: { type: "system" },
        agentDeploymentId: deploymentId,
        agentReleaseId: releaseId,
        channel: "telegram",
        content: "Mismatched channel message",
        environmentId,
        externalThreadKey: "telegram-chat-2",
        idempotencyKey: "channel-message-2",
        organizationId,
        projectId,
        threadId: created.thread.data.id,
        trigger: "chat",
      }),
    ).rejects.toMatchObject({ code: "external_thread_mismatch" });
    expect(memory.transactions).toHaveLength(1);
  });

  test("enqueues the committed run before returning a retryable publication failure", async () => {
    const fixtures = controlFixtures();
    const memory = memoryDatabase([fixtures.deployment, fixtures.release]);
    let appendAttempts = 0;
    let enqueues = 0;
    const service = createConversationService({
      appendThreadEvent: async () => {
        appendAttempts += 1;
        if (appendAttempts === 1) throw new Error("stream unavailable");
      },
      database: memory.database,
      enqueueRun: async () => void (enqueues += 1),
      generateId: idGenerator(),
      now: () => now,
    });
    const input = {
      actor: { type: "system" as const },
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      content: "Accepted despite stream outage",
      environmentId,
      idempotencyKey: "stream-outage-accepted",
      organizationId,
      projectId,
    };

    expect(service.submitTurn(input)).rejects.toMatchObject({ code: "stream_unavailable" });
    expect(service.submitTurn(input)).resolves.toMatchObject({ created: false });
    expect(appendAttempts).toBe(2);
    expect(enqueues).toBe(2);
    expect(memory.transactions).toHaveLength(1);
  });

  test("does not block run enqueueing on a stalled live acceptance publication", async () => {
    const fixtures = controlFixtures();
    const memory = memoryDatabase([fixtures.deployment, fixtures.release]);
    let enqueues = 0;
    const service = createConversationService({
      appendThreadEvent: () => new Promise<void>(() => {}),
      database: memory.database,
      enqueueRun: async () => void (enqueues += 1),
      generateId: idGenerator(),
      now: () => now,
    });

    expect(
      service.submitTurn({
        actor: { type: "system" },
        agentDeploymentId: deploymentId,
        agentReleaseId: releaseId,
        content: "Enqueue despite a stalled live stream",
        environmentId,
        idempotencyKey: "stalled-acceptance-stream",
        organizationId,
        projectId,
      }),
    ).rejects.toMatchObject({ code: "stream_unavailable" });
    expect(enqueues).toBe(1);
  });

  test("rejects queue-incompatible idempotency keys before persistence", async () => {
    const fixtures = controlFixtures();
    const memory = memoryDatabase([fixtures.deployment, fixtures.release]);
    const service = createConversationService({
      database: memory.database,
      enqueueRun: async () => {},
      generateId: idGenerator(),
    });

    expect(
      service.submitTurn({
        actor: { type: "system" },
        agentDeploymentId: deploymentId,
        agentReleaseId: releaseId,
        content: "Too long key",
        environmentId,
        idempotencyKey: "x".repeat(257),
        organizationId,
        projectId,
      }),
    ).rejects.toThrow("at most 256 UTF-8 bytes");
    expect(memory.transactions).toHaveLength(0);
  });

  test("advances an existing thread and exposes ordered canonical history", async () => {
    const fixtures = controlFixtures();
    const threadId = ids[30]!;
    const streamId = ids[31]!;
    const thread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: deploymentId,
          archived: false,
          channel: "api",
          createdAt: now.toISOString(),
          createdBy: { type: "system" as const },
          environmentId,
          id: threadId,
          organizationId,
          pinned: false,
          projectId,
          streamId,
          title: "Existing",
          updatedAt: now.toISOString(),
          version: 1,
          workspaceId,
        },
        itemType: "thread" as const,
      }),
    );
    const memory = memoryDatabase([fixtures.deployment, fixtures.release, thread]);
    const service = createConversationService({
      database: memory.database,
      enqueueRun: async () => {},
      generateId: idGenerator(),
      now: () => now,
    });

    const result = await service.submitTurn({
      actor: { type: "system" },
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      content: "Second user turn",
      environmentId,
      idempotencyKey: "request-456",
      organizationId,
      projectId,
      threadId,
    });
    const history = await readConversationHistory(memory.database, {
      environmentId,
      organizationId,
      projectId,
      threadId,
    });

    expect(result.thread.data.version).toBe(2);
    expect(result.message.data.sequence).toBe(2);
    expect(result.thread.data.streamId).toBe(streamId);
    expect(result.thread.data.workspaceId).toBe(workspaceId);
    expect(result.run.data.workspaceId).toBe(workspaceId);
    expect(history.items.map((message) => message.data.sequence)).toEqual([2]);
  });

  test("replays an accepted turn after its thread is archived", async () => {
    const fixtures = controlFixtures();
    const threadId = ids[30]!;
    const thread = Schema.decodeUnknownSync(ThreadRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: deploymentId,
          archived: false,
          channel: "api",
          createdAt: now.toISOString(),
          createdBy: { type: "system" as const },
          environmentId,
          id: threadId,
          organizationId,
          pinned: false,
          projectId,
          streamId: ids[31]!,
          title: "Existing",
          updatedAt: now.toISOString(),
          version: 1,
          workspaceId,
        },
        itemType: "thread" as const,
      }),
    );
    const memory = memoryDatabase([fixtures.deployment, fixtures.release, thread]);
    const service = createConversationService({
      database: memory.database,
      enqueueRun: async () => {},
      generateId: idGenerator(),
      now: () => now,
    });
    const turn = {
      actor: { type: "system" as const },
      agentDeploymentId: deploymentId,
      agentReleaseId: releaseId,
      content: "Accepted before archive",
      environmentId,
      idempotencyKey: "accepted-before-archive",
      organizationId,
      projectId,
      threadId,
    };

    const created = await service.submitTurn(turn);
    for (const [key, value] of memory.records) {
      if (value.itemType === "thread" && value.data.id === threadId) {
        memory.records.set(
          key,
          Schema.decodeUnknownSync(ThreadRecord)(
            withCanonicalRecordKeys({
              data: { ...value.data, archived: true },
              itemType: "thread" as const,
            }),
          ),
        );
      } else if (value.itemType === "workspace" && value.data.id === workspaceId) {
        memory.records.set(
          key,
          Schema.decodeUnknownSync(WorkspaceRecord)(
            withCanonicalRecordKeys({
              data: { ...value.data, status: "archived", version: value.data.version + 1 },
              itemType: "workspace" as const,
            }),
          ),
        );
      }
    }
    const replayed = await service.submitTurn(turn);

    expect(replayed.created).toBe(false);
    expect(replayed.run.data.id).toBe(created.run.data.id);
    expect(memory.transactions).toHaveLength(1);
  });

  test("rejects history cursors without the exact base-table key", async () => {
    const memory = memoryDatabase();
    const scope = { environmentId, organizationId, projectId, threadId: ids[30]! };
    const partition = key("ORG", organizationId, "THREAD", scope.threadId);

    for (const cursorKey of [
      {},
      { pk: "THREAD#1" },
      { pk: "THREAD#1", sk: "MESSAGE#1", extra: true },
      { pk: key("ORG", organizationId, "THREAD", ids[31]!), sk: "MESSAGE#1" },
      { pk: partition, sk: "RUN#1" },
      { pk: partition, sk: `MESSAGE#${"é".repeat(509)}` },
      { pk: partition, sk: "MESSAGE#1", upperSk: `MESSAGE#${"é".repeat(509)}` },
    ]) {
      const cursor = Buffer.from(JSON.stringify(cursorKey), "utf8").toString("base64url");
      expect(readConversationHistory(memory.database, scope, { cursor })).rejects.toMatchObject({
        code: "invalid_cursor",
      });
    }
    expect(
      readConversationHistory(memory.database, scope, { cursor: "x".repeat(4_097) }),
    ).rejects.toMatchObject({ code: "invalid_cursor" });
  });

  test("retains a consumed snapshot bound after the final database page", async () => {
    const memory = memoryDatabase();
    const scope = { environmentId, organizationId, projectId, threadId: ids[30]! };
    const partition = key("ORG", organizationId, "THREAD", scope.threadId);
    const upperSk = `MESSAGE#${String(2).padStart(12, "0")}#${ids[31]!}`;
    const cursor = Buffer.from(
      JSON.stringify({
        pk: partition,
        sk: `MESSAGE#${String(1).padStart(12, "0")}#${ids[32]!}`,
        upperSk,
      }),
      "utf8",
    ).toString("base64url");

    expect(readConversationHistory(memory.database, scope, { cursor })).resolves.toMatchObject({
      items: [],
      snapshotUpperSk: upperSk,
    });
  });
});
