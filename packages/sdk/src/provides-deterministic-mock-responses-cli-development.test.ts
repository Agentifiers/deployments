import { agentManifestContentHash } from "@deployments-ai/agent-manifest";
import { decodeTenancyResponse } from "@deployments-ai/api-contract/validation";
import { describe, expect, it } from "bun:test";
import {
  createMockPlatformSdk,
  MOCK_TENANCY_CONTEXT,
  MOCK_TENANCY_FIXTURE_IDS,
  PlatformRequestError,
} from "./index.ts";

const ORGANIZATION_ID = MOCK_TENANCY_FIXTURE_IDS.organization;
const PROJECT_ID = MOCK_TENANCY_FIXTURE_IDS.project;
const SERVICE_ACCOUNT_ID = MOCK_TENANCY_FIXTURE_IDS.serviceAccount;
const API_CREDENTIAL_ID = MOCK_TENANCY_FIXTURE_IDS.apiCredential;

describe("platform SDK mock transport", () => {
  it("provides deterministic mock responses for CLI development", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    const response = await sdk.request<{ items: unknown[] }>({
      method: "GET",
      path: "/v1/projects",
      context: { organizationId: ORGANIZATION_ID },
    });
    expect(response.mocked).toBe(true);
    expect(response.requestId).toBe("req_mock_20260720000000000");
    expect(response.data.items).toHaveLength(2);
  });

  it("returns list pages for provider and extension administration routes", async () => {
    const sdk = createMockPlatformSdk({
      now: () => new Date("2026-07-20T00:00:00.000Z"),
    });
    for (const path of [
      "/v1/mcp-servers",
      "/v1/mcp-connections",
      "/v1/extensions",
      "/v1/connections/01ARZ3NDEKTSV4RRFFQ69G5FAX/capabilities",
    ]) {
      const response = await sdk.request<{ items: unknown[]; nextCursor: string | null }>({
        method: "GET",
        path,
      });
      expect(response.data.items, path).toHaveLength(2);
      expect(response.data.nextCursor, path).toBeNull();
    }
  });

  it("returns the canonical public OpenAPI document in mock mode", async () => {
    const sdk = createMockPlatformSdk();
    const response = await sdk.request<{
      readonly openapi: string;
      readonly paths: Readonly<Record<string, unknown>>;
    }>({
      method: "GET",
      path: "/v1/openapi.json",
    });

    expect(response.data.openapi).toBe("3.1.0");
    expect(response.data.paths).toHaveProperty("/health");
    expect(response.data.paths).toHaveProperty("/v1/memory/active-recall");
    expect(Object.keys(response.data.paths).length).toBeGreaterThan(1);
  });

  it("keeps submitted run IDs consistent with mock stream events", async () => {
    const sdk = createMockPlatformSdk();
    const runtime = sdk.runtime({});
    const submitted = await runtime.runs.submit(
      "deployment_1",
      {
        content: "Run the deployment",
        threadId: "thread_1",
      },
      { idempotencyKey: "mock-run-1" },
    );
    const runId = submitted.data.run.id;
    const session = await runtime.threads.createStreamSession("thread_1");
    const page = await runtime.threads.readStreamPage<Record<string, unknown>>(session.data);

    expect(page.items).not.toHaveLength(0);
    expect(page.items.every((event) => event.runId === runId)).toBe(true);
  });

  it("returns the dedicated response shape for every typed runtime SDK method", async () => {
    const runtime = createMockPlatformSdk().runtime({});
    const thread = await runtime.threads.get("thread_1");
    const messages = await runtime.threads.listMessages("thread_1");
    const run = await runtime.runs.get("thread_1", "run_1");
    const approval = await runtime.approvals.resolve("run_1", "approval_1", {
      decision: "approved",
      threadId: "thread_1",
    });
    const toolResult = await runtime.toolCalls.resolve("run_1", "tool_1", {
      externalOperationId: "operation_1",
      outcome: "completed",
      threadId: "thread_1",
    });
    const artifacts = await runtime.artifacts.list({ runId: "run_1" });
    const upload = await runtime.artifacts.createUpload({
      byteSize: 4,
      contentType: "text/plain",
      fileName: "mock.txt",
      name: "Mock artifact",
      sha256: "a".repeat(64),
      type: "file",
    });
    const artifact = await runtime.artifacts.get("artifact_1");
    const completedArtifact = await runtime.artifacts.completeUpload("artifact_1");
    const retainedArtifact = await runtime.artifacts.updateRetention("artifact_1", {
      expectedVersion: 0,
      retentionExpiresAt: "2026-08-20T00:00:00.000Z",
    });
    const artifactUrl = await runtime.artifacts.createAccessUrl("artifact_1");
    const schedules = await runtime.schedules.list();
    const schedule = await runtime.schedules.create(
      {
        agentDeploymentId: "deployment_1",
        expression: "rate(1 hour)",
        name: "Hourly",
        prompt: "Run",
      },
      { idempotencyKey: "schedule-create-1" },
    );
    const scheduleFire = await runtime.schedules.fire("schedule_1", { fireKey: "fire_1" });
    const heartbeats = await runtime.heartbeats.list();
    const heartbeat = await runtime.heartbeats.create(
      {
        agentDeploymentId: "deployment_1",
        instructions: "Check",
      },
      { idempotencyKey: "heartbeat-create-1" },
    );
    const heartbeatFire = await runtime.heartbeats.fire("heartbeat_1", {
      agentDeploymentId: "deployment_1",
      fireKey: "heartbeat-fire-1",
    });

    expect(thread.data.object).toBe("thread");
    expect(messages.data.messages[0]?.object).toBe("message");
    expect(run.data.object).toBe("run");
    expect(approval.data.approval.object).toBe("approval");
    expect(toolResult.data.toolCall.object).toBe("tool-call");
    expect(artifacts.data.artifacts[0]?.object).toBe("artifact");
    expect(upload.data.artifact.status).toBe("pending");
    expect(upload.data.upload.method).toBe("PUT");
    expect(upload.data.upload.headers["content-length"]).toBe("4");
    expect(upload.data.upload.headers["if-none-match"]).toBe("*");
    expect(artifact.data.object).toBe("artifact");
    expect(artifact.data.version).toBe(0);
    expect(completedArtifact.data.status).toBe("available");
    expect(retainedArtifact.data.retentionExpiresAt).toBe("2026-08-20T00:00:00.000Z");
    expect(retainedArtifact.data.version).toBe(1);
    expect(artifactUrl.data.url).toContain("/artifacts/");
    expect(schedules.data.schedules[0]?.object).toBe("schedule");
    expect(schedule.data.object).toBe("schedule");
    expect(scheduleFire.data.fire.object).toBe("schedule-fire");
    expect(heartbeats.data.heartbeats[0]?.object).toBe("heartbeat");
    expect(heartbeat.data.object).toBe("heartbeat");
    expect(heartbeatFire.data.heartbeatRun.object).toBe("heartbeat-run");
  });

  it("provides list and detail mock shapes through the agent-email bridge", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    const email = sdk.agentEmail({
      environmentId: "env_1",
      organizationId: "org_1",
      projectId: "prj_1",
    });
    const domains = await email.domains.list();
    const domain = await email.domains.get("domain_1");
    const bindings = await email.bindings.list("inbox_1");
    const binding = await email.bindings.get("binding_1");
    const messages = await email.messages.list("inbox_1");
    const message = await email.messages.get("message_1");
    const reply = await email.messages.reply("message_1", {}, { idempotencyKey: "idem_reply" });
    const replyAll = await email.messages.replyAll(
      "message_1",
      {},
      { idempotencyKey: "idem_reply_all" },
    );
    const forwarded = await email.messages.forward(
      "message_1",
      { to: ["other@example.com"] },
      { idempotencyKey: "idem_forward" },
    );
    const draft = await email.drafts.get("draft_1");
    const sentDraft = await email.drafts.send("draft_1", {
      idempotencyKey: "idem_send_draft",
    });
    const thread = await email.threads.get("inbox_1", "thread_1");
    const raw = await email.messages.rawAccess("message_1");
    const attachment = await email.attachments.accessUrl("attachment_1");
    const usage = await email.usage.get();
    const usageExport = await email.usage.export({});
    const csvUsageExport = await email.usage.export({
      bucket: "month",
      format: "csv",
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-07-01T00:00:00.000Z",
    });
    const policy = await email.policy.get();
    const suppression = await email.suppressions.remove("suppression_1", {
      idempotencyKey: "idem_remove_suppression",
    });

    expect(domains.data.items).toHaveLength(2);
    expect(domains.data.items[0]).toMatchObject({ organizationId: "org_1" });
    expect(domain.data).toMatchObject({ id: "domain_1", organizationId: "org_1" });
    expect(bindings.data.items).toHaveLength(2);
    expect(binding.data).toMatchObject({
      id: "binding_1",
      inboxId: "inbox_mock",
      status: "active",
    });
    expect(messages.data.items).toHaveLength(2);
    expect(message.data).toMatchObject({
      id: "message_1",
      inboxId: "inbox_mock",
      organizationId: "org_1",
    });
    expect(message.data.attachments).toEqual([]);
    expect(reply.data.id).toBe("message_reply_message_1");
    expect(replyAll.data.id).toBe("message_reply_all_message_1");
    expect(forwarded.data.id).toBe("message_forward_message_1");
    expect(draft.data).toMatchObject({ id: "draft_1", status: "draft" });
    expect(draft.data.toAddresses).toEqual(["recipient@example.com"]);
    expect(sentDraft.data).toMatchObject({ id: "message_draft_1", status: "delivered" });
    expect(thread.data.thread).toMatchObject({ id: "thread_1", inboxId: "inbox_1" });
    expect(thread.data.messages[0]).toMatchObject({ threadId: "thread_1" });
    expect(raw.data.url).toContain("/messages/message_1/raw");
    expect(attachment.data.url).toContain("/attachments/attachment_1");
    expect(usage.data).toMatchObject({ organizationId: "org_1", outboundMessages: 1 });
    expect(usageExport.data.rows[0]).toMatchObject({ organizationId: "org_1", quantity: 1 });
    expect(csvUsageExport.data).toMatchObject({
      bucket: "month",
      format: "csv",
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-07-01T00:00:00.000Z",
    });
    expect(csvUsageExport.data.csv).toContain("bucketStart,kind,organizationId,quantity");
    expect(policy.data).toMatchObject({ organizationId: "org_1", sendingStatus: "active" });
    expect(suppression.data).toMatchObject({ id: "suppression_1", reason: "manual" });
  });

  it("applies live request-path validation to mock transports", async () => {
    const sdk = createMockPlatformSdk();
    for (const path of [
      "https://attacker.example/v1/projects",
      "//attacker.example/v1/projects",
      "/v1\\projects",
      "/v1/projects/..",
      "/v1/projects?all=true",
      "/v1/projects/%ZZ",
      "/v1/projects/..%2Fadmin",
      "/v1/projects/id%5Cadmin",
    ]) {
      expect(sdk.request({ method: "GET", path })).rejects.toBeInstanceOf(PlatformRequestError);
    }
  });

  it("returns detail shapes for ULID and singleton mock reads", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    const project = await sdk.request<Record<string, unknown>>({
      method: "GET",
      path: "/v1/projects/01K0ABCDEF1234567890ABCDEF",
      context: { projectId: "01K0ABCDEF1234567890ABCDEF" },
    });
    expect(project.data).toMatchObject({ id: "01K0ABCDEF1234567890ABCDEF", status: "active" });
    expect(project.data).not.toHaveProperty("items");

    const account = await sdk.request<Record<string, unknown>>({
      method: "GET",
      path: "/v1/account",
    });
    expect(account.data).toMatchObject({ id: "account", status: "ready" });
    expect(account.data).not.toHaveProperty("items");

    for (const path of [
      "/v1/providers/health",
      "/v1/releases/metadata",
      "/v1/providers/tailwind",
    ]) {
      const detail = await sdk.request<Record<string, unknown>>({ method: "GET", path });
      expect(detail.data).toHaveProperty("id");
      expect(detail.data).not.toHaveProperty("capabilities");
      expect(detail.data).not.toHaveProperty("items");
    }
  });

  it("preserves target IDs in mock mutation and lifecycle responses", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    const archived = await sdk.request<Record<string, unknown>>({
      method: "DELETE",
      path: `/v1/projects/${PROJECT_ID}`,
      context: { projectId: PROJECT_ID },
      idempotencyKey: "idem_archive_project",
    });
    expect(archived.data).toMatchObject({ id: PROJECT_ID, status: "archived" });

    const paused = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: "/v1/deployments/dep_1/pause",
    });
    expect(paused.data).toMatchObject({ id: "dep_1", status: "ready" });

    const rawAccess = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: "/v1/agent-email/messages/message_1/raw/access",
    });
    expect(rawAccess.data).toMatchObject({
      url: "https://mock.invalid/agent-email/messages/message_1/raw",
    });

    const rawReprocess = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: "/v1/agent-email/messages/message_1/raw/reprocess",
    });
    expect(rawReprocess.data).toMatchObject({ id: "message_1" });
  });

  it("returns one-time mock secrets only for credential issuance routes", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    const createdApiKey = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: "/v1/api-keys",
      body: { name: "CI", serviceAccountId: SERVICE_ACCOUNT_ID },
      context: { environmentId: MOCK_TENANCY_CONTEXT.environmentId },
      idempotencyKey: "idem_create_api_key",
    });
    expect(createdApiKey.data.secret).toBe("dpl_mock_secret_value");

    const rotatedApiKey = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: `/v1/api-keys/${API_CREDENTIAL_ID}/rotate`,
      context: { environmentId: MOCK_TENANCY_CONTEXT.environmentId },
      idempotencyKey: "idem_rotate_api_key",
    });
    expect(rotatedApiKey.data.secret).toBe("dpl_mock_secret_value");

    for (const path of [
      "/v1/credentials",
      "/v1/credentials/cred_1/rotate",
      "/v1/oauth-apps",
      "/v1/oauth-apps/app_1/rotate",
    ]) {
      const issued = await sdk.request<Record<string, unknown>>({ method: "POST", path });
      expect(issued.data.secret).toBe("dpl_mock_secret_value");
    }

    for (const [method, path] of [
      ["DELETE", `/v1/api-keys/${API_CREDENTIAL_ID}`],
      ["DELETE", "/v1/credentials/cred_1"],
      ["DELETE", "/v1/oauth-apps/app_1"],
    ] as const) {
      const revoked = await sdk.request<Record<string, unknown>>({
        method,
        path,
        context: { environmentId: MOCK_TENANCY_CONTEXT.environmentId },
        idempotencyKey: "idem_revoke_credential",
      });
      expect(revoked.data).not.toHaveProperty("secret");
    }
  });

  it("returns tenancy mocks that satisfy the shared API contract", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    const context = {
      environmentId: MOCK_TENANCY_CONTEXT.environmentId,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    };
    const projects = await sdk.request({ method: "GET", path: "/v1/projects", context });
    expect(() => decodeTenancyResponse("listProjects", projects.data)).not.toThrow();
    const pagedProjects = await sdk.request({
      method: "GET",
      path: "/v1/projects",
      context,
      query: { limit: "25" },
    });
    expect(() => decodeTenancyResponse("listProjects", pagedProjects.data)).not.toThrow();

    const issued = await sdk.request({
      method: "POST",
      path: "/v1/api-keys",
      context,
      body: { name: "CI", serviceAccountId: SERVICE_ACCOUNT_ID },
      idempotencyKey: "idem_contract_create_api_key",
    });
    expect(() => decodeTenancyResponse("createApiCredential", issued.data)).not.toThrow();

    const revoked = await sdk.request({
      method: "DELETE",
      path: `/v1/api-keys/${API_CREDENTIAL_ID}`,
      context,
      idempotencyKey: "idem_contract_revoke_api_key",
    });
    expect(() => decodeTenancyResponse("revokeApiCredential", revoked.data)).not.toThrow();

    const published = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: `/v1/agent-definitions/${MOCK_TENANCY_FIXTURE_IDS.agentDefinition}/releases`,
      context,
      body: { expectedDefinitionVersion: 0 },
      idempotencyKey: "idem_publish_agent_release",
    });
    expect(published.data).toMatchObject({
      agentDefinitionId: MOCK_TENANCY_FIXTURE_IDS.agentDefinition,
      id: MOCK_TENANCY_FIXTURE_IDS.agentRelease,
    });
    expect(published.data.contentHash).toBe(agentManifestContentHash(published.data.manifest));
    expect(() => decodeTenancyResponse("publishAgentRelease", published.data)).not.toThrow();

    const alternateDefinitionId = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";
    expect(
      sdk.request({
        method: "POST",
        path: `/v1/agent-definitions/${alternateDefinitionId}/releases`,
        context,
        body: { expectedDefinitionVersion: 0 },
        idempotencyKey: "idem_publish_alternate_agent_release",
      }),
    ).rejects.toBeInstanceOf(PlatformRequestError);
  });

  it("persists the complete mock workflow definition and release lifecycle", async () => {
    const sdk = createMockPlatformSdk({ now: () => new Date("2026-07-20T00:00:00.000Z") });
    const context = MOCK_TENANCY_CONTEXT;
    const originalDefinition = {
      entryStepId: "prepare",
      name: "Mock release workflow",
      schemaVersion: 1,
      slug: "mock-release-workflow",
      steps: [
        {
          agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          id: "prepare",
          next: "done",
          toolName: "release.prepare",
          type: "tool",
        },
        { id: "done", type: "end" },
      ],
    };
    const created = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: "/v1/workflow-definitions",
      context,
      body: { definition: originalDefinition },
      idempotencyKey: "idem_mock_workflow_create",
    });
    const replayedCreate = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: "/v1/workflow-definitions",
      context,
      body: { definition: originalDefinition },
      idempotencyKey: "idem_mock_workflow_create",
    });
    const definitionId = String(created.data.id);
    const listed = await sdk.request<{ items: Array<Record<string, unknown>> }>({
      method: "GET",
      path: "/v1/workflow-definitions",
      context,
    });
    const fetched = await sdk.request<Record<string, unknown>>({
      method: "GET",
      path: `/v1/workflow-definitions/${definitionId}`,
      context,
    });
    const published = await sdk.request<Record<string, unknown>>({
      method: "POST",
      path: `/v1/workflow-definitions/${definitionId}/releases`,
      context,
      body: { expectedDefinitionVersion: 0 },
      idempotencyKey: "idem_mock_workflow_publish",
    });
    const updatedDefinition = {
      ...originalDefinition,
      name: "Updated mock release workflow",
    };
    const updated = await sdk.request<Record<string, unknown>>({
      method: "PATCH",
      path: `/v1/workflow-definitions/${definitionId}`,
      context,
      body: { definition: updatedDefinition, expectedVersion: 1 },
      idempotencyKey: "idem_mock_workflow_update",
    });
    const releases = await sdk.request<{ items: Array<Record<string, unknown>> }>({
      method: "GET",
      path: `/v1/workflow-definitions/${definitionId}/releases`,
      context,
    });
    const releaseId = String(published.data.id);
    const fetchedRelease = await sdk.request<Record<string, unknown>>({
      method: "GET",
      path: `/v1/workflow-releases/${releaseId}`,
      context,
    });
    const archivedRelease = await sdk.request<Record<string, unknown>>({
      method: "DELETE",
      path: `/v1/workflow-releases/${releaseId}`,
      context,
      body: { expectedVersion: 0 },
      idempotencyKey: "idem_mock_workflow_release_archive",
    });
    const archivedDefinition = await sdk.request<Record<string, unknown>>({
      method: "DELETE",
      path: `/v1/workflow-definitions/${definitionId}`,
      context,
      body: { expectedVersion: 2 },
      idempotencyKey: "idem_mock_workflow_definition_archive",
    });

    expect(replayedCreate.data).toEqual(created.data);
    expect(listed.data.items).toContainEqual(
      expect.objectContaining({ id: definitionId, version: 0 }),
    );
    expect(listed.data.items.find((item) => item.id === definitionId)).not.toHaveProperty("draft");
    expect(fetched.data).toMatchObject({ draft: originalDefinition, id: definitionId });
    expect(published.data).toMatchObject({
      definition: originalDefinition,
      releaseNumber: 1,
      version: 0,
      workflowDefinitionId: definitionId,
    });
    expect(String(published.data.contentHash)).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(updated.data).toMatchObject({ draft: updatedDefinition, version: 2 });
    expect(releases.data.items).toContainEqual(
      expect.objectContaining({ id: releaseId, releaseNumber: 1 }),
    );
    expect(releases.data.items[0]).not.toHaveProperty("definition");
    expect(fetchedRelease.data.definition).toEqual(originalDefinition);
    expect(archivedRelease.data).toMatchObject({ status: "archived", version: 1 });
    expect(archivedDefinition.data).toMatchObject({ status: "archived", version: 3 });
  });
});
