import { describe, expect, test } from "bun:test";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import {
  ApprovalRecord,
  callbackDispatchEvidenceRecord,
  MessageRecord,
  RunRecord,
  ToolCallRecord,
  key,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { ConversationError } from "@deployments-ai/conversations";
import { AutomationError } from "@deployments-ai/automations";
import { StreamSessionExpiredError } from "@deployments-ai/streaming";
import { ApprovalResolutionError } from "@deployments-ai/worker/approvals";
import { Schema } from "effect";
import {
  credentialHash,
  listEnvironmentRecords,
  MAX_RUNTIME_API_HISTORY_RESPONSE_BYTES,
  publicMessage,
  publicMessagePage,
  requireScope,
  requiredIdempotencyKey,
  runtimeApiErrorFromCause,
  signThreadHistoryCursor,
  validatedIdempotencyKey,
  verifyThreadHistoryCursor,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";
import {
  publicApproval,
  publicCallbackDispatchEvidence,
  publicRun,
  publicToolCall,
} from "./public-projections.ts";
import { optionalExternalOperationId } from "./request-validation.ts";

const ids = Array.from(
  { length: 8 },
  (_, index) => `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`,
) as Ulid[];

describe("runtime API message projection", () => {
  test("uses the API-key issuer credential hash format", () => {
    const token = "dpl_test_runtime_credential";
    expect(credentialHash(token)).toBe(createHash("sha256").update(token).digest("hex"));
  });

  test("authenticates thread history cursors to their immutable tenant scope", () => {
    const cursor = Buffer.from(
      JSON.stringify({ pk: "thread-partition", sk: "message-key", upperSk: "snapshot-key" }),
      "utf8",
    ).toString("base64url");
    const scope = {
      environmentId: ids[0]!,
      organizationId: ids[1]!,
      projectId: ids[2]!,
      threadId: ids[3]!,
    };
    const signed = signThreadHistoryCursor(cursor, scope, "test-session-secret");

    expect(verifyThreadHistoryCursor(signed, scope, "test-session-secret")).toBe(cursor);
    expect(
      verifyThreadHistoryCursor(`${cursor}x.${signed.split(".")[1]}`, scope, "test-session-secret"),
    ).toBeUndefined();
    expect(
      verifyThreadHistoryCursor(signed, { ...scope, threadId: ids[4]! }, "test-session-secret"),
    ).toBeUndefined();
  });

  test.each([
    ["platform wildcard", ["platform:*"], ["platform:*"]],
    ["resource wildcard", ["runs:*"], ["runs:*"]],
    ["exact scope", ["runs:write"], ["runs:write"]],
  ])("accepts %s on both runtime identities", (_label, credentialScopes, accountScopes) => {
    const principal = {
      credential: { data: { scopes: credentialScopes } },
      serviceAccount: { data: { scopes: accountScopes } },
    } as unknown as RuntimeApiPrincipal;
    expect(() => requireScope(principal, "runs:write")).not.toThrow();
  });

  test("requires both runtime identities to grant the requested scope", () => {
    const principal = {
      credential: { data: { scopes: ["runs:*"] } },
      serviceAccount: { data: { scopes: ["artifacts:read"] } },
    } as unknown as RuntimeApiPrincipal;
    expect(() => requireScope(principal, "runs:write")).toThrow("requires runs:write");
  });

  test("requires a stable idempotency key header", () => {
    expect(() =>
      requiredIdempotencyKey({
        headers: { "Idempotency-Key": " create-automation-1 " },
        rawPath: "/v1/schedules",
      }),
    ).toThrow("surrounding whitespace");
    expect(() => requiredIdempotencyKey({ rawPath: "/v1/schedules" })).toThrow(
      "idempotency-key is required",
    );
    expect(() =>
      requiredIdempotencyKey({
        headers: { "idempotency-key": "x".repeat(257) },
        rawPath: "/v1/schedules",
      }),
    ).toThrow("at most 256 UTF-8 bytes");
    expect(() =>
      requiredIdempotencyKey({
        headers: { "idempotency-key": "line\nbreak" },
        rawPath: "/v1/schedules",
      }),
    ).toThrow("without control characters");
  });

  test("applies idempotency byte bounds to body fire keys", () => {
    expect(() => validatedIdempotencyKey(" body-fire-1 ", "fireKey")).toThrow(
      "surrounding whitespace",
    );
    expect(() => validatedIdempotencyKey("😀".repeat(65), "fireKey")).toThrow(
      "at most 256 UTF-8 bytes",
    );
    expect(() => validatedIdempotencyKey("line\nbreak", "fireKey")).toThrow(
      "without control characters",
    );
  });

  test("validates provider operation correlation at the HTTP boundary", () => {
    expect(optionalExternalOperationId({ externalOperationId: "provider-operation-1" })).toBe(
      "provider-operation-1",
    );
    expect(optionalExternalOperationId({})).toBeUndefined();
    expect(() => optionalExternalOperationId({ externalOperationId: "" })).toThrow(
      "non-empty string",
    );
    expect(() =>
      optionalExternalOperationId({ externalOperationId: " provider-operation-1 " }),
    ).toThrow("surrounding whitespace");
    expect(() =>
      optionalExternalOperationId({ externalOperationId: "unknown:provider-operation" }),
    ).toThrow("reserved unknown");
  });

  test("redacts internal tool execution fields from public responses", () => {
    const toolCall = Schema.decodeUnknownSync(ToolCallRecord)(
      withCanonicalRecordKeys({
        data: {
          authorizationFingerprint: "sha256:secret-binding",
          connectionId: ids[5]!,
          createdAt: "2026-07-23T12:00:00.000Z",
          effect: "write" as const,
          environmentId: ids[0]!,
          externalAccountId: "private-account",
          id: ids[1]!,
          idempotencyKey: "private-runtime-key",
          input: { accessToken: "secret", target: "production" },
          inputHash: `sha256:${"a".repeat(64)}`,
          inputSummary: "Deploy production",
          observability: {
            captureMode: "metadata-only",
            runSpanId: "0123456789abcdef",
            sessionId: ids[7]!,
            traceId: "0123456789abcdef0123456789abcdef",
          },
          organizationId: ids[2]!,
          policyAction: "allow" as const,
          policyReason: "Allowed",
          projectId: ids[3]!,
          requiredScopes: ["deploy:write"],
          runId: ids[6]!,
          status: "running" as const,
          threadId: ids[7]!,
          toolName: "deployment.start",
          updatedAt: "2026-07-23T12:00:00.000Z",
          version: 0,
        },
        itemType: "tool-call" as const,
      }),
    );

    const projected = publicToolCall(toolCall);
    expect(projected).not.toHaveProperty("input");
    expect(projected).not.toHaveProperty("authorizationFingerprint");
    expect(projected).not.toHaveProperty("connectionId");
    expect(projected).not.toHaveProperty("externalAccountId");
    expect(projected).not.toHaveProperty("idempotencyKey");
    expect(projected).not.toHaveProperty("inputHash");
    expect(projected).not.toHaveProperty("observability");
    expect(projected).toMatchObject({ object: "tool-call", toolName: "deployment.start" });

    const withOutput = Schema.decodeUnknownSync(ToolCallRecord)(
      withCanonicalRecordKeys({
        data: { ...toolCall.data, output: { private: "provider-output" } },
        itemType: "tool-call" as const,
      }),
    );
    expect(publicToolCall(withOutput)).not.toHaveProperty("output");

    const clientToolCall = Schema.decodeUnknownSync(ToolCallRecord)(
      withCanonicalRecordKeys({
        data: {
          ...toolCall.data,
          executionType: "client" as const,
          expiresAt: "2026-07-23T12:15:00.000Z",
          input: { city: "Oslo" },
          output: { temperature: 21.5 },
          outputSchema: { type: "object" },
          status: "succeeded" as const,
        },
        itemType: "tool-call" as const,
      }),
    );
    const clientProjection = publicToolCall(clientToolCall);
    expect(clientProjection).toMatchObject({
      executionType: "client",
      expiresAt: "2026-07-23T12:15:00.000Z",
      input: { city: "Oslo" },
      output: { temperature: 21.5 },
      outputSchema: { type: "object" },
    });
    expect(clientProjection).not.toHaveProperty("authorizationFingerprint");
    expect(clientProjection).not.toHaveProperty("idempotencyKey");
  });

  test("exposes the requesting model generation without the private idempotency key", () => {
    const modelAttemptId = `${ids[6]!}:execution:2:assistant:1:run-attempt:0:fallback:0`;
    const toolCall = Schema.decodeUnknownSync(ToolCallRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-23T12:00:00.000Z",
          effect: "read" as const,
          environmentId: ids[0]!,
          id: ids[1]!,
          idempotencyKey: `${ids[6]!}:model-tool:1:0`,
          inputSummary: "Model requested provider.read.",
          modelAttemptId,
          modelCallIndex: 1,
          organizationId: ids[2]!,
          projectId: ids[3]!,
          requiredScopes: [],
          runId: ids[6]!,
          status: "succeeded" as const,
          threadId: ids[7]!,
          toolName: "provider.read",
          updatedAt: "2026-07-23T12:00:01.000Z",
          version: 0,
        },
        itemType: "tool-call" as const,
      }),
    );

    const projected = publicToolCall(toolCall);
    expect(projected).toMatchObject({ modelAttemptId, modelCallIndex: 1, object: "tool-call" });
    expect(projected).not.toHaveProperty("idempotencyKey");
  });

  test("redacts internal approval observability fields from public responses", () => {
    const approval = Schema.decodeUnknownSync(ApprovalRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: "2026-07-23T12:00:00.000Z",
          environmentId: ids[0]!,
          escalationCount: 0,
          id: ids[1]!,
          observability: {
            captureMode: "metadata-only",
            runSpanId: "0123456789abcdef",
            sessionId: ids[7]!,
            traceId: "0123456789abcdef0123456789abcdef",
          },
          organizationId: ids[2]!,
          projectId: ids[3]!,
          request: { reason: "Deploy production" },
          requestedByAgentDeploymentId: ids[5]!,
          runId: ids[6]!,
          status: "pending",
          threadId: ids[7]!,
          updatedAt: "2026-07-23T12:00:00.000Z",
          version: 0,
        },
        itemType: "approval",
      }),
    );

    const projected = publicApproval(approval);
    expect(projected).not.toHaveProperty("observability");
    expect(projected).toMatchObject({ object: "approval", status: "pending" });
  });

  test("projects durable callback evidence without input or connector authorization details", () => {
    const evidence = callbackDispatchEvidenceRecord({
      agentDefinitionId: ids[0]!,
      agentDeploymentId: ids[1]!,
      agentReleaseId: ids[2]!,
      authorizationFingerprint: "sha256:private-authorization",
      connectionId: ids[3]!,
      createdAt: "2026-07-23T12:00:00.000Z",
      effect: "write",
      environmentId: ids[4]!,
      executionKind: "agent-run",
      externalAccountId: "private-account",
      id: ids[5]!,
      idempotencyKey: "callback-write-1",
      input: { accessToken: "secret", target: "production" },
      inputHash: `sha256:${"b".repeat(64)}`,
      inputSummary: JSON.stringify({ accessToken: "secret", target: "production" }),
      organizationId: ids[6]!,
      policyAction: "allow",
      policyReason: "Allowed",
      projectId: ids[7]!,
      requiredScopes: ["records:write"],
      runId: ids[0]!,
      threadId: ids[1]!,
      toolAdapterId: ids[2]!,
      toolCallId: ids[5]!,
      toolName: "records.write",
      toolPlanFingerprint: "private-plan",
    });

    const projected = publicCallbackDispatchEvidence(evidence);
    expect(projected).not.toHaveProperty("input");
    expect(projected).not.toHaveProperty("authorizationFingerprint");
    expect(projected).not.toHaveProperty("connectionId");
    expect(projected).not.toHaveProperty("externalAccountId");
    expect(projected).not.toHaveProperty("inputSummary");
    expect(projected).toMatchObject({
      id: ids[5],
      inputHash: `sha256:${"b".repeat(64)}`,
      object: "callback-dispatch-evidence",
      policyAction: "allow",
    });
  });

  test("redacts internal run execution fields from public responses", () => {
    const run = Schema.decodeUnknownSync(RunRecord)(
      withCanonicalRecordKeys({
        data: {
          agentDeploymentId: ids[1]!,
          agentReleaseId: ids[2]!,
          attempt: 1,
          captureMode: "metadata-only" as const,
          claimedAt: "2026-07-23T12:00:00.000Z",
          claimedBy: "worker-secret",
          createdAt: "2026-07-23T11:59:00.000Z",
          environmentId: ids[3]!,
          executor: "hosted",
          heartbeatAt: "2026-07-23T12:00:01.000Z",
          id: ids[4]!,
          idempotencyKey: "private-request-key",
          organizationId: ids[5]!,
          priority: 1,
          projectId: ids[6]!,
          redactionPolicyVersion: 1 as const,
          runContext: "private workflow snapshot",
          schemaVersion: 1 as const,
          sandboxPoolId: ids[7]!,
          status: "running",
          spanId: "0123456789abcdef",
          threadId: ids[0]!,
          toolContinuation: { private: true },
          trigger: "api",
          traceId: "0123456789abcdef0123456789abcdef",
          updatedAt: "2026-07-23T12:00:01.000Z",
          version: 1,
        },
        itemType: "run" as const,
      }),
    );

    expect(publicRun(run)).not.toHaveProperty("claimedBy");
    expect(publicRun(run)).not.toHaveProperty("heartbeatAt");
    expect(publicRun(run)).not.toHaveProperty("idempotencyKey");
    expect(publicRun(run)).not.toHaveProperty("sandboxPoolId");
    expect(publicRun(run)).not.toHaveProperty("runContext");
    expect(publicRun(run)).not.toHaveProperty("toolContinuation");
    expect(publicRun(run)).toMatchObject({ id: ids[4], object: "run", status: "running" });
  });

  test("replaces a retained legacy body reference with a short-lived scoped access URL", async () => {
    const message = Schema.decodeUnknownSync(MessageRecord)(
      withCanonicalRecordKeys({
        data: {
          bodyRef: {
            bucket: "legacy-artifact-bucket",
            byteSize: 180_000,
            contentType: "text/plain; charset=utf-8",
            key: "message-bodies/body.txt",
            sha256: "a".repeat(64),
            versionId: "version-1",
          },
          contentHash: "a".repeat(64),
          createdAt: "2026-07-23T12:00:00.000Z",
          environmentId: ids[0]!,
          id: ids[1]!,
          organizationId: ids[2]!,
          projectId: ids[3]!,
          role: "assistant" as const,
          sequence: 1,
          threadId: ids[4]!,
        },
        itemType: "message" as const,
      }),
    );
    let command: GetObjectCommand | undefined;
    const dependencies = {
      artifactBucket: "artifact-bucket",
      legacyArtifactBuckets: ["legacy-artifact-bucket"],
      artifactS3: {} as never,
      now: () => new Date("2026-07-23T12:00:00.000Z"),
    } as unknown as RuntimeApiDependencies;

    const projected = await publicMessage(message, dependencies, async (_client, input) => {
      command = input;
      return "https://signed.example.test/body";
    });

    expect(projected).not.toHaveProperty("bodyRef");
    expect(projected).toMatchObject({
      bodyAccess: {
        byteSize: 180_000,
        expiresAt: "2026-07-23T12:05:00.000Z",
        url: "https://signed.example.test/body",
      },
      object: "message",
    });
    expect(command?.input).toMatchObject({
      Bucket: "legacy-artifact-bucket",
      Key: "message-bodies/body.txt",
      VersionId: "version-1",
    });
  });

  test("paginates projected message history before the response exceeds its byte budget", async () => {
    const messages = Array.from({ length: 20 }, (_, index) =>
      Schema.decodeUnknownSync(MessageRecord)(
        withCanonicalRecordKeys({
          data: {
            body: "x".repeat(256 * 1024),
            contentHash: "a".repeat(64),
            createdAt: "2026-07-23T12:00:00.000Z",
            environmentId: ids[0]!,
            id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(index).padStart(2, "0")}`,
            organizationId: ids[2]!,
            projectId: ids[3]!,
            role: "user" as const,
            sequence: index,
            threadId: ids[4]!,
          },
          itemType: "message" as const,
        }),
      ),
    );
    const snapshotUpperSk = messages.at(-1)!.sk;
    const page = await publicMessagePage(
      messages,
      {} as RuntimeApiDependencies,
      undefined,
      snapshotUpperSk,
    );

    expect(page.messages.length).toBeGreaterThan(0);
    expect(page.messages.length).toBeLessThan(messages.length);
    expect(page.nextCursor).toBeDefined();
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(
      MAX_RUNTIME_API_HISTORY_RESPONSE_BYTES,
    );
    const decoded = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"));
    expect(decoded).toEqual({
      pk: messages[page.messages.length - 1]!.pk,
      sk: messages[page.messages.length - 1]!.sk,
      upperSk: snapshotUpperSk,
    });
  });

  test("returns and accepts opaque cursors for environment record pages", async () => {
    const calls: Array<Readonly<Record<string, unknown>>> = [];
    const database = {
      queryRecords: (_table: string, input: Readonly<Record<string, unknown>>) => {
        calls.push(input);
        return Promise.resolve({
          items: [{ data: {}, itemType: "schedule" } as never],
          ...(input.ExclusiveStartKey
            ? {}
            : {
                lastEvaluatedKey: {
                  gsi2pk: key("ENV", ids[0]!),
                  gsi2sk: "SCHEDULE#active#2026-07-24T00:00:00.000Z#id",
                  pk: "source-pk",
                  sk: "source-sk",
                },
              }),
        });
      },
    } as never;

    const first = await listEnvironmentRecords(database, "control", ids[0]!, "schedule", {
      limit: 25,
    });
    expect(first.nextCursor).toBeDefined();
    await listEnvironmentRecords(database, "control", ids[0]!, "schedule", {
      ...(first.nextCursor ? { cursor: first.nextCursor } : {}),
      limit: 25,
    });
    expect(calls[1]?.ExclusiveStartKey).toEqual({
      gsi2pk: key("ENV", ids[0]!),
      gsi2sk: "SCHEDULE#active#2026-07-24T00:00:00.000Z#id",
      pk: "source-pk",
      sk: "source-sk",
    });
    expect(
      listEnvironmentRecords(database, "control", ids[0]!, "schedule", {
        cursor: Buffer.from(JSON.stringify({ gsi2pk: "next" }), "utf8").toString("base64url"),
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
    expect(
      listEnvironmentRecords(database, "control", ids[0]!, "schedule", {
        cursor: Buffer.from(
          JSON.stringify({
            gsi2pk: key("ENV", ids[0]!),
            gsi2sk: `SCHEDULE#${"x".repeat(1_025)}`,
            pk: "source-pk",
            sk: "source-sk",
          }),
          "utf8",
        ).toString("base64url"),
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
    expect(
      listEnvironmentRecords(database, "control", ids[0]!, "schedule", {
        cursor: Buffer.from(
          JSON.stringify({
            gsi2pk: key("ENV", ids[1]!),
            gsi2sk: "HEARTBEAT#active#2026-07-24T00:00:00.000Z#id",
            pk: "source-pk",
            sk: "source-sk",
          }),
          "utf8",
        ).toString("base64url"),
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
    expect(
      listEnvironmentRecords(database, "control", ids[0]!, "schedule", {
        cursor: "x".repeat(4_097),
      }),
    ).rejects.toMatchObject({ code: "invalid_cursor", status: 400 });
  });

  test("maps expected runtime failures to explicit client responses", () => {
    expect(
      runtimeApiErrorFromCause(new StreamSessionExpiredError("2026-07-23T12:00:00.000Z")),
    ).toMatchObject({
      code: "stream_session_expired",
      status: 401,
    });
    expect(
      runtimeApiErrorFromCause(new ConversationError("message_too_large", "Message is too large.")),
    ).toMatchObject({ code: "message_too_large", status: 413 });
    expect(
      runtimeApiErrorFromCause(new ConversationError("thread_archived", "Thread is archived.")),
    ).toMatchObject({ code: "thread_archived", status: 409 });
    expect(
      runtimeApiErrorFromCause(
        new ConversationError("trigger_not_allowed", "Trigger is not allowed."),
      ),
    ).toMatchObject({
      code: "trigger_not_allowed",
      message: "Trigger is not allowed.",
      status: 409,
    });
    expect(
      runtimeApiErrorFromCause(
        new ConversationError("workspace_unavailable", "Workspace is inactive."),
      ),
    ).toMatchObject({ code: "workspace_unavailable", status: 409 });
    expect(
      runtimeApiErrorFromCause(
        new ConversationError("stream_unavailable", "Stream is unavailable."),
      ),
    ).toMatchObject({ code: "stream_unavailable", status: 503 });
    expect(
      runtimeApiErrorFromCause(
        new AutomationError("idempotency_conflict", "Automation key conflict."),
      ),
    ).toMatchObject({ code: "idempotency_conflict", status: 409 });
    expect(
      runtimeApiErrorFromCause(
        new AutomationError("workspace_unavailable", "Workspace is inactive."),
      ),
    ).toMatchObject({ code: "workspace_unavailable", status: 409 });
    expect(
      runtimeApiErrorFromCause(
        new AutomationError("automation_archived", "Automation is archived."),
      ),
    ).toMatchObject({ code: "automation_archived", status: 409 });
    expect(
      runtimeApiErrorFromCause(
        new AutomationError("trigger_not_allowed", "Trigger is not allowed."),
      ),
    ).toMatchObject({
      code: "trigger_not_allowed",
      message: "Trigger is not allowed.",
      status: 409,
    });
    expect(
      runtimeApiErrorFromCause(new ApprovalResolutionError("approval_not_found", "Missing.")),
    ).toMatchObject({ code: "approval_not_found", status: 404 });
    expect(
      runtimeApiErrorFromCause(
        new ApprovalResolutionError("invalid_external_operation_id", "Invalid."),
      ),
    ).toMatchObject({ code: "invalid_external_operation_id", status: 400 });
    expect(
      runtimeApiErrorFromCause(
        new ApprovalResolutionError("approval_already_resolved", "Resolved."),
      ),
    ).toMatchObject({ code: "approval_already_resolved", status: 409 });
    expect(
      runtimeApiErrorFromCause(
        new ApprovalResolutionError("run_enqueue_unavailable", "Queue ARN is unavailable."),
      ),
    ).toMatchObject({
      code: "run_enqueue_unavailable",
      message: "Internal server error.",
      status: 500,
    });
    expect(runtimeApiErrorFromCause(new Error("arn:aws:secret/internal"))).toMatchObject({
      code: "internal_error",
      message: "Internal server error.",
      status: 500,
    });
  });
});
