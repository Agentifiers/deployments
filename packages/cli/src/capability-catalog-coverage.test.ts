import { PUBLIC_API_ROUTES } from "@deployments-ai/api-contract/product";
import { RUNTIME_API_ROUTES } from "@deployments-ai/api-contract/runtime";
import { MOCK_TENANCY_FIXTURE_IDS } from "@agentifiers/deployments-sdk";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandCatalog, initialPlanCommands, scaffoldCommandCatalog } from "./catalog.ts";
import { buildRequest } from "./command-runtime.ts";
import { customCommandRoutes } from "./custom-command-routes.ts";

const temporaryDirectories: string[] = [];
const temporaryServers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  await Promise.all(temporaryServers.splice(0).map((server) => server.stop(true)));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("CLI capability catalog", () => {
  const normalizedRoute = (method: string, path: string) =>
    `${method} ${path.replaceAll(/:[^/]+/gu, "{}")}`;

  it("covers every authoritative public API operation without exposing scaffold routes", () => {
    const catalogRoutes = Object.values(commandCatalog).flatMap((resource) =>
      Object.values(resource.actions).map((action) => normalizedRoute(action.method, action.path)),
    );
    const cliRoutes = new Set([
      ...catalogRoutes,
      ...Object.values(customCommandRoutes)
        .flat()
        .map(({ method, path }) => normalizedRoute(method, path)),
    ]);
    const publicRoutes = new Set(
      PUBLIC_API_ROUTES.map((route) => normalizedRoute(route.method, route.path)),
    );

    expect(
      PUBLIC_API_ROUTES.filter(
        (route) => !cliRoutes.has(normalizedRoute(route.method, route.path)),
      ).map((route) => route.name),
    ).toEqual([]);
    expect(catalogRoutes.filter((route) => !publicRoutes.has(route))).toEqual([]);
  });

  it("contains every initial migration-plan command", () => {
    const commands = new Set([
      "auth login",
      "auth logout",
      "whoami",
      "chat",
      ...Object.entries(scaffoldCommandCatalog).flatMap(([resource, definition]) =>
        Object.keys(definition.actions).map((action) => `${resource} ${action}`),
      ),
    ]);
    expect(initialPlanCommands.filter((command) => !commands.has(command))).toEqual([]);
  });

  it("marks destructive POST actions and GET search filters correctly", () => {
    expect(commandCatalog["api-key"]?.actions.rotate?.destructive).toBe(true);
    expect(commandCatalog.run?.actions.cancel?.destructive).toBe(true);
    expect(commandCatalog.run?.actions.replay?.destructive).toBe(true);
    expect(commandCatalog.thread?.actions.archive?.destructive).toBe(true);
    expect(commandCatalog.webhook?.actions.archive?.destructive).toBe(true);
    expect(commandCatalog.memory?.actions.search?.args?.query?.target).toBe("body");
    expect(commandCatalog.memory?.actions.list?.pagination).toEqual({
      limitField: "limit",
      maxLimit: 20,
      target: "query",
    });
    expect(commandCatalog.deployment?.actions.pause?.path).toBe("/v1/agent-deployments/:id");
    expect(commandCatalog.deployment?.actions.pause?.fixedBody).toEqual({
      desiredState: "paused",
    });
    expect(commandCatalog.deployment?.actions.resume?.fixedBody).toEqual({
      desiredState: "running",
    });
    expect(commandCatalog.deployment?.actions.update?.args?.["desired-state"]).toBeUndefined();
    expect(commandCatalog.governance?.actions.erase?.destructive).toBe(true);
    expect(commandCatalog.governance?.actions.erase?.fixedBody).toEqual({
      confirmation: "ERASE",
    });
    expect(commandCatalog.governance?.actions.erase?.args).not.toHaveProperty("reason");
    expect(commandCatalog.deployment?.actions.stop?.destructive).toBe(true);
    expect(commandCatalog["channel-binding"]?.actions.list?.listField).toBe("channelBindings");
    expect(commandCatalog["channel-binding"]?.actions.list?.pagination).toEqual({
      limitField: "limit",
      maxLimit: 100,
      target: "query",
    });
    expect(commandCatalog["channel-binding"]?.actions.create?.idempotent).toBe(true);
    expect(commandCatalog["channel-binding"]?.actions.update?.idempotent).toBeUndefined();
    expect(commandCatalog["channel-binding"]?.actions.archive?.destructive).toBe(true);
    expect(commandCatalog["channel-binding"]?.actions.verify?.idempotent).toBeUndefined();
    expect(commandCatalog["channel-binding"]?.actions.deliver?.idempotent).toBe(true);
    expect(commandCatalog["channel-delivery"]?.actions.list?.listField).toBe("channelDeliveries");
    expect(commandCatalog["channel-delivery"]?.actions.show?.args?.id?.field).toBe("deliveryId");
    expect(commandCatalog["channel-delivery"]?.actions.show?.args?.run?.field).toBe("runId");
    expect(commandCatalog.schedule?.actions.fire?.path).toBe("/v1/schedules/:scheduleId/fire");
    expect(commandCatalog.schedule?.actions.create?.args?.["agent-deployment-id"]).toBeDefined();
    expect(commandCatalog.schedule?.actions.create?.args?.expression).toBeDefined();
    expect(commandCatalog.schedule?.actions.create?.args?.prompt).toBeDefined();
    expect(commandCatalog.schedule?.actions.show?.args?.id?.field).toBe("scheduleId");
    expect(commandCatalog.schedule?.actions.update?.idempotent).toBeUndefined();
    expect(commandCatalog.schedule?.actions.archive?.destructive).toBe(true);
    expect(commandCatalog.schedule?.actions.pause?.idempotent).toBeUndefined();
    expect(commandCatalog.schedule?.actions.resume?.idempotent).toBeUndefined();
    expect(commandCatalog.schedule?.actions.fires?.listField).toBe("fires");
    expect(commandCatalog.schedule?.actions.list?.listField).toBe("schedules");
    expect(commandCatalog.schedule?.actions.list?.pagination).toEqual({
      limitField: "limit",
      maxLimit: 100,
      target: "query",
    });
    expect(commandCatalog.heartbeat?.actions.create?.path).toBe("/v1/heartbeats");
    expect(commandCatalog.heartbeat?.actions.create?.args?.["agent-deployment-id"]).toBeDefined();
    expect(commandCatalog.heartbeat?.actions.send).toBeUndefined();
    expect(commandCatalog.heartbeat?.actions.fire?.path).toBe("/v1/heartbeats/:heartbeatId/fire");
    expect(commandCatalog.heartbeat?.actions.fire?.args?.["agent-deployment-id"]).toBeDefined();
    expect(commandCatalog.heartbeat?.actions.show?.args?.id?.field).toBe("heartbeatId");
    expect(commandCatalog.heartbeat?.actions.update?.idempotent).toBeUndefined();
    expect(commandCatalog.heartbeat?.actions.archive?.destructive).toBe(true);
    expect(commandCatalog.heartbeat?.actions.pause?.idempotent).toBeUndefined();
    expect(commandCatalog.heartbeat?.actions.resume?.idempotent).toBeUndefined();
    expect(commandCatalog.heartbeat?.actions.fires?.listField).toBe("fires");
    expect(commandCatalog.heartbeat?.actions.list?.listField).toBe("heartbeats");
    expect(commandCatalog.heartbeat?.actions.list?.pagination).toEqual({
      limitField: "limit",
      maxLimit: 100,
      target: "query",
    });
    expect(commandCatalog["api-key"]?.actions.rotate?.path).toBe("/v1/api-keys/:id/rotate");
    expect(scaffoldCommandCatalog["oauth-app"]?.actions.rotate?.path).toBe(
      "/v1/oauth-apps/:id/rotate",
    );
    expect(scaffoldCommandCatalog.credential?.actions.rotate?.path).toBe(
      "/v1/credentials/:id/rotate",
    );
    expect(scaffoldCommandCatalog.connection?.actions.verify?.path).toBe(
      "/v1/connections/:id/verify",
    );
    expect(commandCatalog.grant?.actions.create?.args?.workspace?.bodyField).toBe("workspaceId");
    expect(commandCatalog.grant?.actions.create?.args?.scopes?.bodyField).toBeUndefined();
    expect(commandCatalog.capability?.actions.list?.path).toBe("/v1/connections/:id/capabilities");
    expect(commandCatalog["tool-policy"]?.actions.create?.args?.policy).toBeDefined();
    expect(commandCatalog["mcp-server"]?.actions.discover?.path).toBe(
      "/v1/mcp-servers/:id/discover",
    );
    expect(commandCatalog.extension?.actions.show?.path).toBe("/v1/extensions/:toolName");
    expect(scaffoldCommandCatalog["inbox-domain"]?.actions.refresh?.path).toBe(
      "/v1/agent-email/domains/:id/refresh",
    );
    expect(scaffoldCommandCatalog["inbox-domain"]?.actions.revoke?.destructive).toBe(true);
    expect(scaffoldCommandCatalog["inbox-domain"]?.actions.create?.scope).toBe("environment");
    expect(scaffoldCommandCatalog["inbox-binding"]?.actions.create?.path).toBe(
      "/v1/agent-email/inboxes/:inbox/bindings",
    );
    expect(scaffoldCommandCatalog.inbox?.actions.send?.path).toBe(
      "/v1/agent-email/inboxes/:id/messages",
    );
    expect(scaffoldCommandCatalog["inbox-message"]?.actions["raw-access"]?.sensitiveOutput).toBe(
      true,
    );
    expect(
      scaffoldCommandCatalog["inbox-message"]?.actions["raw-access"]?.sensitiveOutputFields,
    ).toEqual(["url"]);
    expect(scaffoldCommandCatalog["inbox-attachment"]?.actions.access?.sensitiveOutput).toBe(true);
    expect(scaffoldCommandCatalog.draft?.actions.update?.args?.status).toBeUndefined();
    expect(
      scaffoldCommandCatalog["email-policy"]?.actions.update?.args?.["sending-status"],
    ).toBeDefined();
    expect(
      scaffoldCommandCatalog["email-policy"]?.actions.update?.args?.["warmup-stage"],
    ).toBeDefined();
    expect(scaffoldCommandCatalog["email-policy"]?.actions.update?.args?.allowlist).toBeDefined();
    expect(scaffoldCommandCatalog["email-policy"]?.actions.update?.args?.blocklist).toBeDefined();
    expect(commandCatalog["api-key"]?.actions.create?.sensitiveOutput).toBe(true);
    expect(commandCatalog["service-account"]?.actions.create?.sensitiveOutput).not.toBe(true);
    expect(commandCatalog.artifact?.actions.download?.sensitiveOutput).toBe(true);
    expect(commandCatalog.artifact?.actions.download?.path).toBe(
      "/v1/artifacts/:artifactId/access-urls",
    );
    expect(commandCatalog.artifact?.actions.download?.args?.["expires-in-seconds"]?.transform).toBe(
      "number",
    );
    expect(commandCatalog.webhook?.actions.create?.sensitiveOutput).toBe(true);
    expect(commandCatalog.webhook?.actions.create?.idempotent).not.toBe(true);
    expect(commandCatalog.thread?.actions.create?.idempotent).not.toBe(true);
    expect(commandCatalog.artifact?.actions.upload?.args?.["byte-size"]).toMatchObject({
      definition: { required: true },
      transform: "number",
    });
    expect(commandCatalog.artifact?.actions.retention?.args?.["expected-version"]).toMatchObject({
      definition: { required: true },
      transform: "number",
    });
    expect(
      commandCatalog.artifact?.actions.retention?.args?.["retention-expires-at"],
    ).toMatchObject({
      definition: { required: true },
      transform: "json",
    });
    expect(scaffoldCommandCatalog.webhook?.actions.create?.sensitiveOutput).toBe(true);
  });

  it("serializes forwarding without the original message", async () => {
    const spec = scaffoldCommandCatalog["inbox-message"]!.actions.forward!;
    const context = {
      apiUrl: "https://api.example.test",
      environmentId: MOCK_TENANCY_FIXTURE_IDS.environment,
      mock: false,
      profileName: "test",
    } as const;

    const request = await buildRequest(
      spec,
      {
        "exclude-original": true,
        id: "message_1",
        to: "recipient@example.test",
      },
      context,
      {},
    );
    expect(request.body).toMatchObject({
      includeOriginal: false,
      to: ["recipient@example.test"],
    });
    expect(
      buildRequest(
        spec,
        {
          "exclude-original": true,
          id: "message_1",
          "include-original": true,
          to: "recipient@example.test",
        },
        context,
        {},
      ),
    ).rejects.toThrow("Conflicting values were provided for includeOriginal");
  });

  it("maps supported runtime commands to the canonical hosted runtime contract", async () => {
    const route = (name: (typeof RUNTIME_API_ROUTES)[number]["name"]) =>
      RUNTIME_API_ROUTES.find((candidate) => candidate.name === name);
    expect(commandCatalog.run?.actions.create?.path).toBe(route("submitAgentRun")?.path);
    expect(commandCatalog.run?.actions.list?.path).toBe(route("listRuns")?.path);
    expect(commandCatalog.run?.actions.list?.listField).toBe("runs");
    expect(commandCatalog.run?.actions.search?.path).toBe(route("searchRuns")?.path);
    expect(commandCatalog.run?.actions.search?.listField).toBe("runs");
    expect(commandCatalog.run?.actions.show?.path).toBe(route("getRun")?.path);
    expect(commandCatalog.run?.actions.message?.path).toBe(route("getRunMessage")?.path);
    expect(commandCatalog.run?.actions.cancel?.path).toBe(route("cancelRun")?.path);
    expect(commandCatalog.run?.actions.retry?.path).toBe(route("retryRun")?.path);
    expect(commandCatalog.run?.actions.retry?.destructive).toBe(true);
    expect(commandCatalog.run?.actions.replay?.path).toBe(route("replayRun")?.path);
    expect(commandCatalog.thread?.actions.list?.path).toBe(route("listThreads")?.path);
    expect(commandCatalog.thread?.actions.list?.listField).toBe("threads");
    expect(commandCatalog.thread?.actions.create?.path).toBe(route("createThread")?.path);
    expect(commandCatalog.thread?.actions.show?.path).toBe(route("getThread")?.path);
    expect(commandCatalog.thread?.actions.archive?.path).toBe(route("archiveThread")?.path);
    expect(commandCatalog.message?.actions.list?.path).toBe(route("listThreadMessages")?.path);
    expect(commandCatalog.message?.actions.list?.listField).toBe("messages");
    expect(commandCatalog.thread?.actions.messages?.listField).toBe("messages");
    expect(commandCatalog.approval?.actions.list?.path).toBe(route("listApprovals")?.path);
    expect(commandCatalog.approval?.actions.list?.listField).toBe("approvals");
    expect(commandCatalog.approval?.actions.show?.path).toBe(route("getApproval")?.path);
    expect(commandCatalog.approval?.actions.approve?.path).toBe(route("resolveApproval")?.path);
    expect(commandCatalog.approval?.actions.reject?.path).toBe(route("resolveApproval")?.path);
    expect(commandCatalog["callback-evidence"]?.actions.show?.path).toBe(
      route("getCallbackDispatchEvidence")?.path,
    );
    expect(commandCatalog["tool-call"]?.actions.list?.path).toBe(route("listRunToolCalls")?.path);
    expect(commandCatalog["tool-call"]?.actions.list?.listField).toBe("toolCalls");
    expect(commandCatalog["tool-call"]?.actions.result?.path).toBe(
      route("resolveToolResult")?.path,
    );
    expect(commandCatalog.webhook?.actions.list?.path).toBe(route("listWebhooks")?.path);
    expect(commandCatalog.webhook?.actions.list?.listField).toBe("webhooks");
    expect(commandCatalog.webhook?.actions.create?.path).toBe(route("createWebhook")?.path);
    expect(commandCatalog.webhook?.actions.show?.path).toBe(route("getWebhook")?.path);
    expect(commandCatalog.webhook?.actions.archive?.path).toBe(route("archiveWebhook")?.path);
    expect(commandCatalog["webhook-delivery"]?.actions.list?.path).toBe(
      route("listWebhookDeliveries")?.path,
    );
    expect(commandCatalog["webhook-delivery"]?.actions.list?.listField).toBe("deliveries");
    expect(commandCatalog["webhook-delivery"]?.actions.list?.args?.status?.target).toBe("query");
    expect(commandCatalog.webhook?.actions.update?.path).toBe(route("updateWebhook")?.path);
    expect(commandCatalog.webhook?.actions.update?.method).toBe("PATCH");
    expect(commandCatalog.webhook?.actions.disable?.path).toBe(route("disableWebhook")?.path);
    expect(commandCatalog.webhook?.actions.enable?.path).toBe(route("enableWebhook")?.path);
    expect(commandCatalog.webhook?.actions["rotate-secret"]?.path).toBe(
      route("rotateWebhookSecret")?.path,
    );
    expect(commandCatalog.webhook?.actions["rotate-secret"]?.sensitiveOutputFields).toEqual([
      "signingSecret",
    ]);
    expect(
      commandCatalog.webhook?.actions["rotate-secret"]?.args?.["previous-secret-expires-in-seconds"]
        ?.transform,
    ).toBe("number");
    expect(commandCatalog.webhook?.actions.test?.path).toBe(route("testWebhook")?.path);
    expect(commandCatalog["webhook-delivery"]?.actions.show?.path).toBe(
      route("getWebhookDelivery")?.path,
    );
    expect(commandCatalog["webhook-delivery"]?.actions.attempts?.path).toBe(
      route("listWebhookDeliveryAttempts")?.path,
    );
    expect(commandCatalog["webhook-delivery"]?.actions.attempts?.listField).toBe("attempts");
    expect(commandCatalog["webhook-delivery"]?.actions.retry?.path).toBe(
      route("retryWebhookDelivery")?.path,
    );
    expect(commandCatalog.artifact?.actions.show?.path).toBe(route("getArtifact")?.path);
    expect(commandCatalog.artifact?.actions.download?.path).toBe(
      route("createArtifactAccessUrl")?.path,
    );
    expect(commandCatalog.message?.actions.send).toBeUndefined();
    expect(commandCatalog["tool-call"]?.actions.show).toBeUndefined();

    const context = {
      apiUrl: "https://api.example.test",
      environmentId: MOCK_TENANCY_FIXTURE_IDS.environment,
      mock: false,
      profileName: "test",
    } as const;
    const runRequest = await buildRequest(
      commandCatalog.run!.actions.create!,
      {
        agent: "deployment_1",
        message: "Run the deployment",
        thread: "thread_1",
        "idempotency-key": "idem_run",
      },
      context,
      {},
    );
    expect(runRequest).toMatchObject({
      body: { content: "Run the deployment", threadId: "thread_1" },
      method: "POST",
      path: "/v1/agent-deployments/deployment_1/runs",
    });
    const reservationAction = commandCatalog.run!.actions["reserve-message-publication"]!;
    const publicationAction = commandCatalog.run!.actions["publish-message"]!;
    const releaseAction = commandCatalog.run!.actions["release-message-publication"]!;
    expect([
      reservationAction.requiresExplicitIdempotencyKey,
      publicationAction.requiresExplicitIdempotencyKey,
      releaseAction.requiresExplicitIdempotencyKey,
    ]).toEqual([true, true, true]);
    expect(
      buildRequest(
        reservationAction,
        { id: "run_1", message: "Delivered message", thread: "thread_1" },
        context,
        {},
      ),
    ).rejects.toThrow("--idempotency-key is required for this multi-phase operation");
    const reservationRequest = await buildRequest(
      reservationAction,
      {
        id: "run_1",
        message: "Delivered message",
        thread: "thread_1",
        "idempotency-key": "shared-publication-key",
      },
      context,
      {},
    );
    expect(reservationRequest.idempotencyKey).toBe("shared-publication-key");
    const runSearchRequest = await buildRequest(
      commandCatalog.run!.actions.search!,
      {
        "agent-deployment-id": "deployment_1",
        "created-after": "2026-07-01T00:00:00.000Z",
        "page-size": "25",
        status: "failed",
        thread: "thread_1",
      },
      context,
      {},
    );
    expect(runSearchRequest).toMatchObject({
      body: {
        agentDeploymentId: "deployment_1",
        createdAfter: "2026-07-01T00:00:00.000Z",
        limit: 25,
        status: "failed",
        threadId: "thread_1",
      },
      method: "POST",
      path: "/v1/runs/search",
    });
    const threadRequest = await buildRequest(
      commandCatalog.thread!.actions.create!,
      {
        "agent-deployment-id": "deployment_1",
        title: "Incident review",
        "workspace-id": "workspace_1",
      },
      context,
      {},
    );
    expect(threadRequest).toMatchObject({
      body: {
        agentDeploymentId: "deployment_1",
        title: "Incident review",
        workspaceId: "workspace_1",
      },
      method: "POST",
      path: "/v1/threads",
    });
    const approvalRequest = await buildRequest(
      commandCatalog.approval!.actions.approve!,
      { id: "approval_1", run: "run_1", thread: "thread_1" },
      context,
      {},
    );
    expect(approvalRequest).toMatchObject({
      body: { decision: "approved", threadId: "thread_1" },
      method: "POST",
      path: "/v1/runs/run_1/approvals/approval_1/resolve",
    });
    const webhookRequest = await buildRequest(
      commandCatalog.webhook!.actions.create!,
      {
        "event-types": "run.completed,run.failed",
        name: "Runtime completion",
        "resource-filters": '{"aggregateTypes":["run"]}',
        url: "https://example.test/hooks/runtime",
      },
      context,
      {},
    );
    expect(webhookRequest).toMatchObject({
      body: {
        eventTypes: ["run.completed", "run.failed"],
        name: "Runtime completion",
        resourceFilters: { aggregateTypes: ["run"] },
        url: "https://example.test/hooks/runtime",
      },
      method: "POST",
      path: "/v1/webhooks",
    });
  });

  it("maps agent lifecycle commands to the versioned public contract", async () => {
    const context = {
      apiUrl: "https://api.example.test",
      environmentId: MOCK_TENANCY_FIXTURE_IDS.environment,
      mock: false,
      profileName: "test",
    } as const;
    const manifest = {
      apiVersion: "agents.deployments.ai/v1",
      kind: "Agent",
      metadata: { key: "cli.agent", name: "CLI Agent", version: "1.0.0" },
      spec: {
        instructions: "Complete the requested task.",
        model: { id: "openrouter/default" },
        sandbox: { mode: "none" },
      },
    };
    const createSpec = commandCatalog.agent?.actions.create;
    const releaseSpec = commandCatalog.agent?.actions.release;
    const deploySpec = commandCatalog.agent?.actions.deploy;
    const pauseSpec = commandCatalog.deployment?.actions.pause;
    if (!createSpec || !releaseSpec || !deploySpec || !pauseSpec) {
      throw new Error("Agent command catalog is incomplete.");
    }

    expect(
      await buildRequest(createSpec, { manifest: JSON.stringify(manifest) }, context, {}),
    ).toMatchObject({
      body: { manifest },
      method: "POST",
      path: "/v1/agent-definitions",
    });
    expect(
      await buildRequest(
        releaseSpec,
        {
          id: MOCK_TENANCY_FIXTURE_IDS.agentDefinition,
          "expected-version": "2",
        },
        context,
        {},
      ),
    ).toMatchObject({
      body: { expectedDefinitionVersion: 2 },
      path: `/v1/agent-definitions/${MOCK_TENANCY_FIXTURE_IDS.agentDefinition}/releases`,
    });
    expect(
      await buildRequest(
        deploySpec,
        { release: MOCK_TENANCY_FIXTURE_IDS.agentRelease },
        context,
        {},
      ),
    ).toMatchObject({
      body: { agentReleaseId: MOCK_TENANCY_FIXTURE_IDS.agentRelease },
      path: "/v1/agent-deployments",
    });
    expect(
      await buildRequest(
        pauseSpec,
        {
          id: MOCK_TENANCY_FIXTURE_IDS.agentDeployment,
          "expected-version": "1",
        },
        context,
        {},
      ),
    ).toMatchObject({
      body: { desiredState: "paused", expectedVersion: 1 },
      method: "PATCH",
      path: `/v1/agent-deployments/${MOCK_TENANCY_FIXTURE_IDS.agentDeployment}`,
    });
  });

  it("maps preview commands and execution-binding listings to the runtime contract", async () => {
    const route = (name: (typeof RUNTIME_API_ROUTES)[number]["name"]) =>
      RUNTIME_API_ROUTES.find((candidate) => candidate.name === name)?.path;
    const preview = commandCatalog.preview!.actions;
    expect(preview.create?.path).toBe(route("createPreview"));
    expect(preview.show?.path).toBe(route("getPreview"));
    expect(preview.delete?.path).toBe(route("deletePreview"));
    expect(preview.turn?.path).toBe(route("submitPreviewTurn"));
    const context = {
      apiUrl: "https://api.example.test",
      environmentId: MOCK_TENANCY_FIXTURE_IDS.environment,
      mock: false,
      profileName: "test",
    } as const;
    const directory = await mkdtemp(join(tmpdir(), "preview-cli-"));
    temporaryDirectories.push(directory);
    const manifestPath = join(directory, "manifest.json");
    await writeFile(manifestPath, JSON.stringify({ name: "draft" }));
    expect(
      await buildRequest(
        preview.create!,
        {
          "from-agent-deployment-id": "deployment_1",
          "idempotency-key": "idem_preview",
          "manifest-file": manifestPath,
          "ttl-seconds": "600",
        },
        context,
        {},
      ),
    ).toMatchObject({
      body: { fromAgentDeploymentId: "deployment_1", manifest: { name: "draft" }, ttlSeconds: 600 },
      idempotencyKey: "idem_preview",
      method: "POST",
      path: "/v1/previews",
    });
    expect(
      buildRequest(preview.create!, { "manifest-file": manifestPath, manifest: "{}" }, context, {}),
    ).rejects.toThrow("Choose either --manifest-file or --manifest.");
    expect(
      await buildRequest(
        preview.turn!,
        { id: "preview_1", message: "Try it", "idempotency-key": "idem_turn" },
        context,
        {},
      ),
    ).toMatchObject({
      body: { content: "Try it" },
      idempotencyKey: "idem_turn",
      path: "/v1/previews/preview_1/turns",
    });
    expect(
      await buildRequest(
        commandCatalog.run!.actions.list!,
        { "execution-binding-id": "preview_1" },
        context,
        {},
      ),
    ).toMatchObject({ path: "/v1/runs", query: { executionBindingId: "preview_1" } });
    expect(
      await buildRequest(
        commandCatalog.thread!.actions.list!,
        { "execution-binding-id": "preview_1" },
        context,
        {},
      ),
    ).toMatchObject({ path: "/v1/threads", query: { executionBindingId: "preview_1" } });
  });
});
