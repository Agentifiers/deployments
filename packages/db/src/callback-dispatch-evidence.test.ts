import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CallbackDispatchEvidenceError,
  callbackDispatchEvidenceRecord,
  makeCallbackDispatchEvidencePersistence,
} from "./callback-dispatch-evidence.ts";
import { DatabaseError, type TransactionOperation } from "./client-types.ts";
import { Ulid } from "./ids.ts";
import { withCanonicalRecordKeys } from "./records/index.ts";
import {
  AgentDeploymentRecord,
  CredentialVaultEntryRecord,
  ProviderConnectionRecord,
  ToolAdapterRecord,
  WorkspaceConnectionAuthorizationRecord,
} from "./records/control.ts";
import { WorkflowApprovalRecord, WorkflowExecutionRecord } from "./records/workflows.ts";

const id = (suffix: string) => Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`);

const input = {
  agentDefinitionId: id("00"),
  agentDeploymentId: id("01"),
  agentReleaseId: id("02"),
  authorizationFingerprint: "sha256:authorization-v1",
  connectionId: id("03"),
  createdAt: "2026-08-08T12:00:00.000Z",
  effect: "write" as const,
  environmentId: id("04"),
  executionKind: "workflow" as const,
  externalAccountId: "vertical-account",
  id: id("05"),
  idempotencyKey: "workflow:execution:write:0",
  input: { offerId: "offer-1", revision: 2 },
  inputHash: `sha256:${"a".repeat(64)}`,
  inputSummary: "Accept offer revision 2.",
  organizationId: id("06"),
  policyAction: "require-approval" as const,
  policyReason: "Commercial mutations require approval.",
  projectId: id("07"),
  requiredScopes: ["commerce:write"],
  runId: id("08"),
  threadId: id("09"),
  toolAdapterId: id("10"),
  toolCallId: id("05"),
  toolName: "commerce.offer.accept",
  toolPlanFingerprint: "sha256:tool-plan-v1",
  workspaceId: id("11"),
  approval: {
    expiresAt: "2026-08-08T13:00:00.000Z",
    id: id("12"),
    kind: "workflow" as const,
    resolvedBy: { id: id("13"), type: "principal" as const },
    status: "approved" as const,
  },
};

const execution = Schema.decodeUnknownSync(WorkflowExecutionRecord)(
  withCanonicalRecordKeys({
    data: {
      activeStepAttemptId: input.threadId,
      context: {},
      createdAt: input.createdAt,
      currentStepAttempt: 0,
      currentStepId: "write",
      environmentId: input.environmentId,
      id: input.runId,
      idempotencyKey: "workflow-execution-1",
      initiatedBy: { id: id("14"), type: "principal" as const },
      input: {},
      organizationId: input.organizationId,
      projectId: input.projectId,
      startedAt: input.createdAt,
      status: "running" as const,
      stepTransitionCount: 1,
      updatedAt: input.createdAt,
      version: 3,
      workflowContentHash: "sha256:workflow-v1",
      workflowDefinitionId: id("15"),
      workflowReleaseId: id("16"),
      workflowReleaseNumber: 1,
      workspaceId: input.workspaceId,
    },
    itemType: "workflow-execution" as const,
  }),
);

const approval = Schema.decodeUnknownSync(WorkflowApprovalRecord)(
  withCanonicalRecordKeys({
    data: {
      createdAt: input.createdAt,
      environmentId: input.environmentId,
      expiresAt: input.approval.expiresAt,
      id: input.approval.id,
      organizationId: input.organizationId,
      projectId: input.projectId,
      prompt: "Approve callback",
      requestedBy: { id: id("17"), type: "principal" as const },
      resolvedAt: input.createdAt,
      resolvedBy: input.approval.resolvedBy,
      status: "approved" as const,
      stepAttemptId: id("18"),
      updatedAt: input.createdAt,
      version: 2,
      workflowExecutionId: input.runId,
    },
    itemType: "workflow-approval" as const,
  }),
);

const workspaceAuthorization = Schema.decodeUnknownSync(WorkspaceConnectionAuthorizationRecord)(
  withCanonicalRecordKeys({
    data: {
      authorizationVersion: 1,
      connectionId: input.connectionId,
      createdAt: input.createdAt,
      environmentId: input.environmentId,
      externalAccountId: input.externalAccountId,
      externalResourceConstraints: {},
      id: id("20"),
      organizationId: input.organizationId,
      projectId: input.projectId,
      providerKey: "github",
      purpose: "agent-runtime",
      resourceScopeHash: "sha256:resource-scope-v1",
      scopes: input.requiredScopes,
      status: "active" as const,
      updatedAt: input.createdAt,
      version: 1,
      workspaceId: input.workspaceId,
    },
    itemType: "workspace-connection-authorization" as const,
  }),
);

const agentDeployment = Schema.decodeUnknownSync(AgentDeploymentRecord)(
  withCanonicalRecordKeys({
    data: {
      agentDefinitionId: input.agentDefinitionId,
      agentReleaseId: input.agentReleaseId,
      createdAt: input.createdAt,
      currentState: "ready" as const,
      desiredState: "running" as const,
      environmentId: input.environmentId,
      id: input.agentDeploymentId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      runtimeConfig: {
        apiVersion: "agents.deployments.ai/v1" as const,
        kind: "AgentDeploymentConfig" as const,
        toolAuthorizations: {
          [input.toolName]: { authorizationId: workspaceAuthorization.data.id },
        },
      },
      updatedAt: input.createdAt,
      version: 2,
    },
    itemType: "agent-deployment" as const,
  }),
);

const connection = Schema.decodeUnknownSync(ProviderConnectionRecord)(
  withCanonicalRecordKeys({
    data: {
      authMethod: "static",
      createdAt: input.createdAt,
      environmentId: input.environmentId,
      externalAccountId: input.externalAccountId,
      id: input.connectionId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      providerKey: workspaceAuthorization.data.providerKey,
      scopes: input.requiredScopes,
      status: "active" as const,
      updatedAt: input.createdAt,
      version: 4,
    },
    itemType: "provider-connection" as const,
  }),
);

const toolAdapter = Schema.decodeUnknownSync(ToolAdapterRecord)(
  withCanonicalRecordKeys({
    data: {
      authSecretRef: { credentialId: id("21"), generation: 7, store: "dynamodb-kms" as const },
      createdAt: input.createdAt,
      effect: input.effect,
      environmentId: input.environmentId,
      execution: {
        completionMode: "sync",
        endpointOrigin: "https://callbacks.example.com",
        endpointPath: "/v1/tools/write",
        type: "http_callback",
      },
      id: input.toolAdapterId,
      name: input.toolName,
      organizationId: input.organizationId,
      projectId: input.projectId,
      providerKey: workspaceAuthorization.data.providerKey,
      requiredScopes: input.requiredScopes,
      status: "active" as const,
      updatedAt: input.createdAt,
      version: 5,
    },
    itemType: "tool-adapter" as const,
  }),
);

const toolCredential = Schema.decodeUnknownSync(CredentialVaultEntryRecord)(
  withCanonicalRecordKeys({
    data: {
      algorithm: "AES-256-GCM" as const,
      authTag: "encrypted-auth-tag",
      ciphertext: "encrypted-callback-secret",
      createdAt: input.createdAt,
      encryptedDataKey: "encrypted-data-key",
      encryptionContextHash: "sha256:encryption-context-v1",
      environmentId: input.environmentId,
      generation: 7,
      id: id("21"),
      iv: "initialization-vector",
      kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/callback",
      organizationId: input.organizationId,
      ownerId: toolAdapter.data.id,
      ownerType: "tool-adapter" as const,
      projectId: input.projectId,
      purpose: "tool-adapter-auth",
      status: "active" as const,
      updatedAt: input.createdAt,
      version: 3,
    },
    itemType: "credential-vault-entry" as const,
  }),
);

const control = {
  executionTarget: agentDeployment,
  connection,
  providerUsesNoCredential: false,
  toolAdapter,
  toolCredential,
  workspaceAuthorization,
} as const;
const authorization = { approval, control, execution } as const;
const fixedNow = () => new Date(input.createdAt);
const fixedGenerateId = async () => id("19");

describe("callback dispatch evidence", () => {
  test("builds immutable tenant-scoped evidence independent of run record layout", () => {
    const record = callbackDispatchEvidenceRecord(input);

    expect(record).toMatchObject({
      itemType: "callback-dispatch-evidence",
      pk: `ORG#${input.organizationId}#CALLBACK-DISPATCH-EVIDENCE`,
      sk: `CALLBACK-DISPATCH-EVIDENCE#${input.id}`,
      data: input,
    });
    expect(record.data).not.toHaveProperty("status");
    expect(record.data).not.toHaveProperty("updatedAt");
    expect(record.data).not.toHaveProperty("version");
  });

  test("requires approval evidence exactly when policy requires approval", () => {
    const { approval: _approval, ...withoutApproval } = input;
    expect(() => callbackDispatchEvidenceRecord(withoutApproval)).toThrow("approval");
    expect(() => callbackDispatchEvidenceRecord({ ...input, policyAction: "allow" })).toThrow(
      "approval",
    );
  });

  test("rejects evidence that cannot fit in one DynamoDB item", () => {
    expect(() =>
      callbackDispatchEvidenceRecord({
        ...input,
        input: { payload: "x".repeat(400 * 1_024) },
      }),
    ).toThrow("fit in one DynamoDB item");
  });

  test("records a channel origin for agent runs only", () => {
    const origin = {
      channelBindingId: id("40"),
      externalChannelId: "C07QK3MV9",
      externalMessageId: "slack:T024BE7LD:C07QK3MV9:1729700123.000200",
      externalThreadKey: "slack:T024BE7LD:thread:C07QK3MV9:1729700000.000100",
      kind: "channel" as const,
      provider: "slack_edge",
      sender: { id: "U02ADA1OVE" },
    };
    const { approval: _approval, ...agentRun } = {
      ...input,
      executionKind: "agent-run" as const,
      policyAction: "allow" as const,
    };

    expect<unknown>(callbackDispatchEvidenceRecord({ ...agentRun, origin }).data.origin).toEqual({
      channelBindingId: "01ARZ3NDEKTSV4RRFFQ69G5F40",
      externalChannelId: "C07QK3MV9",
      externalMessageId: "slack:T024BE7LD:C07QK3MV9:1729700123.000200",
      externalThreadKey: "slack:T024BE7LD:thread:C07QK3MV9:1729700000.000100",
      kind: "channel",
      provider: "slack_edge",
      sender: { id: "U02ADA1OVE" },
    });
    expect(() => callbackDispatchEvidenceRecord({ ...input, origin })).toThrow(
      "origin is recorded only for agent runs",
    );
  });

  test("pins customer dispatches to a deployment and bound dispatches to an execution binding", () => {
    const {
      agentDeploymentId: _deployment,
      agentDefinitionId: _definition,
      agentReleaseId: _release,
      approval: _approval,
      ...unpinned
    } = input;
    const bound = {
      ...unpinned,
      executionBindingId: id("30"),
      executionKind: "agent-run" as const,
      executionPurpose: "preview" as const,
      policyAction: "allow" as const,
    };

    expect(callbackDispatchEvidenceRecord(bound).data).toMatchObject({
      executionBindingId: bound.executionBindingId,
      executionPurpose: "preview",
    });
    expect(() =>
      callbackDispatchEvidenceRecord({
        ...bound,
        agentDeploymentId: input.agentDeploymentId,
      } as never),
    ).toThrow("require executionBindingId");
    expect(() =>
      callbackDispatchEvidenceRecord({ ...bound, executionKind: "workflow" } as never),
    ).toThrow("require executionBindingId");
    expect(() =>
      callbackDispatchEvidenceRecord({ ...bound, agentReleaseId: input.agentReleaseId } as never),
    ).toThrow("require executionBindingId");
  });

  test("atomically creates evidence against exact execution and approval snapshots", async () => {
    const transactions: { operations: readonly TransactionOperation[]; token?: string }[] = [];
    let evidenceReadCompleted = false;
    const persistence = makeCallbackDispatchEvidencePersistence({
      database: {
        getRecord: async () => {
          evidenceReadCompleted = true;
          return undefined;
        },
        putRecord: async () => {},
        transactWrite: async (operations: readonly TransactionOperation[], token?: string) => {
          transactions.push({ operations, ...(token ? { token } : {}) });
        },
      } as never,
      generateId: fixedGenerateId,
      now: () => {
        expect(evidenceReadCompleted).toBe(true);
        return fixedNow();
      },
    });

    await persistence.create(input, authorization);

    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "put",
          record: expect.objectContaining({ itemType: "callback-dispatch-evidence" }),
        }),
        expect.objectContaining({
          expressionAttributeValues: expect.objectContaining({
            ":itemType": "workflow-execution",
            ":running": "running",
            ":version": execution.data.version,
          }),
          key: { pk: execution.pk, sk: execution.sk },
          kind: "condition-check",
          table: "execution",
        }),
        ...[agentDeployment, workspaceAuthorization, connection, toolAdapter, toolCredential].map(
          (record) =>
            expect.objectContaining({
              expressionAttributeValues: expect.objectContaining({
                ":itemType": record.itemType,
                ":version": record.data.version,
              }),
              key: { pk: record.pk, sk: record.sk },
              kind: "condition-check",
              table: "control",
            }),
        ),
        expect.objectContaining({
          expressionAttributeValues: expect.objectContaining({
            ":approved": "approved",
            ":expiresAt": approval.data.expiresAt,
            ":itemType": "workflow-approval",
            ":observedAt": input.createdAt,
            ":version": approval.data.version,
          }),
          key: { pk: approval.pk, sk: approval.sk },
          kind: "condition-check",
          table: "execution",
        }),
        expect.objectContaining({
          kind: "put",
          record: expect.objectContaining({
            itemType: "semantic-event",
            data: expect.objectContaining({
              aggregateId: input.id,
              aggregateType: "callback-dispatch-evidence",
              aggregateVersion: 1,
              eventType: "callback-dispatch-evidence.created",
            }),
          }),
        }),
      ]),
    );
    expect(transactions[0]?.operations).toHaveLength(9);
    expect(transactions[0]?.token).toBeString();
  });

  test("accepts an environment grant only while its provider uses no credential", async () => {
    const { workspaceId: _workspaceId, ...environmentGrantData } = workspaceAuthorization.data;
    const environmentGrant = Schema.decodeUnknownSync(WorkspaceConnectionAuthorizationRecord)(
      withCanonicalRecordKeys({
        data: environmentGrantData,
        itemType: "workspace-connection-authorization" as const,
      }),
    );
    const otherWorkspaceGrant = Schema.decodeUnknownSync(WorkspaceConnectionAuthorizationRecord)(
      withCanonicalRecordKeys({
        data: { ...environmentGrantData, workspaceId: id("31") },
        itemType: "workspace-connection-authorization" as const,
      }),
    );
    const transactions: (readonly TransactionOperation[])[] = [];
    const persistence = makeCallbackDispatchEvidencePersistence({
      database: {
        getRecord: async () => undefined,
        transactWrite: async (operations: readonly TransactionOperation[]) => {
          transactions.push(operations);
        },
      } as never,
      generateId: fixedGenerateId,
      now: fixedNow,
    });

    expect(environmentGrant.data.workspaceId).toBeUndefined();
    await persistence.create(input, {
      ...authorization,
      control: {
        ...control,
        providerUsesNoCredential: true,
        workspaceAuthorization: environmentGrant,
      },
    });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toContainEqual(
      expect.objectContaining({
        expressionAttributeValues: expect.objectContaining({
          ":itemType": "workspace-connection-authorization",
          ":version": 1,
        }),
        key: { pk: environmentGrant.pk, sk: environmentGrant.sk },
        kind: "condition-check",
      }),
    );
    const refusals = await Promise.all(
      [
        { ...control, providerUsesNoCredential: false, workspaceAuthorization: environmentGrant },
        { ...control, providerUsesNoCredential: true, workspaceAuthorization: otherWorkspaceGrant },
      ].map((refused) =>
        persistence.create(input, { ...authorization, control: refused }).then(
          () => undefined,
          (cause: unknown) => (cause instanceof Error ? cause.message : cause),
        ),
      ),
    );
    expect(refusals).toEqual([
      "Callback dispatch control snapshot does not match its active workspace authorization.",
      "Callback dispatch control snapshot does not match its active workspace authorization.",
    ]);
    expect(transactions).toHaveLength(1);
  });

  test("reconciles a concurrent create whose only difference is generated time", async () => {
    const raced = callbackDispatchEvidenceRecord({
      ...input,
      createdAt: "2026-08-08T12:00:01.000Z",
    });
    const conflict = new DatabaseError({
      cause: new Error("conditional write lost"),
      message: "write conflict",
      operation: "put",
      reason: "conflict",
      table: "execution",
    });
    let reads = 0;
    let writes = 0;
    const tokens: (string | undefined)[] = [];
    const persistence = makeCallbackDispatchEvidencePersistence({
      database: {
        getRecord: async () => {
          reads += 1;
          return reads === 1 ? undefined : raced;
        },
        transactWrite: async (_operations: readonly TransactionOperation[], token?: string) => {
          writes += 1;
          tokens.push(token);
          if (writes === 1) throw conflict;
        },
      } as never,
      generateId: fixedGenerateId,
      now: fixedNow,
    });

    expect(persistence.create(input, authorization)).resolves.toEqual(raced);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  test("reauthorizes an identical evidence replay against current canonical state", async () => {
    const stored = callbackDispatchEvidenceRecord(input);
    const transactions: { operations: readonly TransactionOperation[]; token?: string }[] = [];
    const persistence = makeCallbackDispatchEvidencePersistence({
      database: {
        getRecord: async () => stored,
        transactWrite: async (operations: readonly TransactionOperation[], token?: string) => {
          transactions.push({ operations, ...(token ? { token } : {}) });
        },
      } as never,
      generateId: fixedGenerateId,
      now: fixedNow,
    });

    expect(persistence.create(input, authorization)).resolves.toEqual(stored);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.operations).toHaveLength(9);
    expect(
      transactions[0]?.operations.some(
        (operation) =>
          typeof operation === "object" &&
          operation !== null &&
          "kind" in operation &&
          operation.kind === "put",
      ),
    ).toBe(false);
    expect(transactions[0]?.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conditionExpression:
            "attribute_not_exists(pk) OR #fenceData.#fenceLeaseExpiresAt <= :fenceObservedAt",
          key: {
            pk: `ORG#${input.organizationId}`,
            sk: `ERASURE-FENCE#${input.organizationId}`,
          },
        }),
        expect.objectContaining({
          conditionExpression: "attribute_exists(pk)",
          key: { pk: `ORG#${input.organizationId}`, sk: `ORG#${input.organizationId}` },
        }),
      ]),
    );
    expect(transactions[0]?.token).toBeString();
  });

  test("rejects creation when the execution changes before the transaction", async () => {
    const conflict = new DatabaseError({
      cause: new Error("execution changed"),
      message: "write conflict",
      operation: "transact-write",
      reason: "conflict",
      table: "execution",
    });
    let attemptedEvidenceWrite = false;
    const persistence = makeCallbackDispatchEvidencePersistence({
      database: {
        getRecord: async () => undefined,
        transactWrite: async (operations: readonly TransactionOperation[]) => {
          attemptedEvidenceWrite = operations.some(
            (operation) =>
              operation.kind === "put" &&
              operation.record.itemType === "callback-dispatch-evidence",
          );
          const executionCheck = operations.find(
            (operation) =>
              operation.kind === "condition-check" &&
              operation.expressionAttributeValues?.[":itemType"] === "workflow-execution",
          );
          if (executionCheck) throw conflict;
        },
      } as never,
      generateId: fixedGenerateId,
      now: fixedNow,
    });

    expect(persistence.create(input, authorization)).rejects.toBeInstanceOf(
      CallbackDispatchEvidenceError,
    );
    expect(attemptedEvidenceWrite).toBe(true);
  });

  test("rejects creation when the approval changes before the transaction", async () => {
    const conflict = new DatabaseError({
      cause: new Error("approval expired"),
      message: "write conflict",
      operation: "transact-write",
      reason: "conflict",
      table: "execution",
    });
    let approvalWasFenced = false;
    const persistence = makeCallbackDispatchEvidencePersistence({
      database: {
        getRecord: async () => undefined,
        transactWrite: async (operations: readonly TransactionOperation[]) => {
          approvalWasFenced = operations.some(
            (operation) =>
              operation.kind === "condition-check" &&
              operation.expressionAttributeValues?.[":itemType"] === "workflow-approval" &&
              operation.conditionExpression.includes("#data.#expiresAt > :observedAt"),
          );
          if (approvalWasFenced) throw conflict;
        },
      } as never,
      generateId: fixedGenerateId,
      now: fixedNow,
    });

    expect(persistence.create(input, authorization)).rejects.toBeInstanceOf(
      CallbackDispatchEvidenceError,
    );
    expect(approvalWasFenced).toBe(true);
  });

  test("rejects creation when a control-plane authorization changes before the transaction", async () => {
    const conflict = new DatabaseError({
      cause: new Error("workspace authorization revoked"),
      message: "write conflict",
      operation: "transact-write",
      reason: "conflict",
      table: "control",
    });
    let controlWasFenced = false;
    const persistence = makeCallbackDispatchEvidencePersistence({
      database: {
        getRecord: async () => undefined,
        transactWrite: async (operations: readonly TransactionOperation[]) => {
          controlWasFenced = operations.some(
            (operation) =>
              operation.kind === "condition-check" &&
              operation.expressionAttributeValues?.[":itemType"] ===
                "workspace-connection-authorization" &&
              operation.expressionAttributeValues[":version"] ===
                workspaceAuthorization.data.version,
          );
          if (controlWasFenced) throw conflict;
        },
      } as never,
      generateId: fixedGenerateId,
      now: fixedNow,
    });

    expect(persistence.create(input, authorization)).rejects.toMatchObject({
      code: "authorization_conflict",
    });
    expect(controlWasFenced).toBe(true);
  });

  test("preserves transient database write failures for caller retry", async () => {
    const transient = new DatabaseError({
      cause: new Error("DynamoDB throttled"),
      message: "write unavailable",
      operation: "put",
      reason: "unknown",
      table: "execution",
    });
    const persistence = makeCallbackDispatchEvidencePersistence({
      database: {
        getRecord: async () => undefined,
        transactWrite: async () => {
          throw transient;
        },
      } as never,
      generateId: fixedGenerateId,
      now: fixedNow,
    });

    expect(persistence.create(input, authorization)).rejects.toBe(transient);
  });
});
