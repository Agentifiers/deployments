import { expect, it } from "@effect/vitest";
import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import { E2eHttpClient, httpClientLayer } from "../harness/http-client.ts";
import {
  acquireLiveAgent,
  cleanupHttpResult,
  numberField,
  record,
  retryUnavailableHttpRequest,
  stringField,
} from "../harness/live-agent.ts";
import {
  credentialedE2eEnabled,
  e2eApiUrl,
  safeJwtMetadata,
  scopedE2eConfig,
} from "../harness/live-config.ts";
import { json, records } from "../harness/response-records.ts";
import { liveAgentModel } from "../harness/live-model.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";
import { brainMcp, brainToolOutput, makeBrainApi, problemCode } from "./brain-lifecycle-support.ts";

const enabled = credentialedE2eEnabled();
const BRAIN_MCP_TOOLS = [
  "brain.ask",
  "brain.capture",
  "brain.get_document",
  "brain.get_entity",
  "brain.search",
];

it.effect.skipIf(!enabled)(
  "proves Brain grants, mounts, upload capture, indexing, search, ask, feedback, hosted MCP, mounted agent search, and erasure",
  () =>
    Effect.gen(function* () {
      const config = yield* scopedE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const api = makeBrainApi(config, http);
      const runKey = `e2e-brain-${randomUUID()}`;
      const marker = `quasar${randomUUID().replaceAll("-", "").slice(0, 12)}`;

      const brain = yield* Effect.acquireRelease(
        api
          .request({
            body: { kind: "company", name: `E2E Brain ${runKey}`, slug: runKey },
            idempotencyKey: `${runKey}:brain`,
            method: "POST",
            path: "/v1/brains",
          })
          .pipe(
            Effect.map((response) =>
              json(
                response,
                201,
                `Brain create (JWT ${safeJwtMetadata(config.platformCredential.token)})`,
              ),
            ),
          ),
        (created) =>
          Effect.gen(function* () {
            const brainPath = `/v1/brains/${stringField(created, "id", "Brain")}`;
            const current = yield* api.request({ method: "GET", path: brainPath });
            // Erasing or archived Brains deny reads with brain_brain_inactive: nothing to archive.
            if (
              current.status === 403 &&
              (current.json as { readonly code?: unknown } | undefined)?.code ===
                "brain_brain_inactive"
            ) {
              return;
            }
            if (current.status !== 200 || record(current.json, "Brain").status !== "active") {
              return yield* cleanupHttpResult("Brain", current);
            }
            yield* cleanupHttpResult(
              "Brain archive",
              yield* api.request({
                body: {
                  expectedVersion: numberField(record(current.json, "Brain"), "version", "Brain"),
                },
                idempotencyKey: `${runKey}:brain:archive`,
                method: "DELETE",
                path: brainPath,
              }),
            );
          }).pipe(Effect.orDie),
      );
      const brainId = stringField(brain, "id", "Brain");
      const brainPath = `/v1/brains/${brainId}`;
      expect(brain).toMatchObject({ kind: "company", slug: runKey, status: "active" });
      const searchSummary = `Search Brain ${brainId} for the ${marker} release train.`;
      const agent = yield* acquireLiveAgent(
        cli,
        config,
        runKey,
        {
          apiVersion: "agents.deployments.ai/v1",
          kind: "Agent",
          metadata: { key: runKey, name: `E2E Brain ${runKey}`, version: "1.0.0" },
          spec: {
            capabilities: {
              tools: [
                {
                  authorization: "none",
                  name: "agent.brain.search",
                  required: false,
                  requiredScopes: [],
                },
              ],
            },
            instructions: "Answer from the Brain search evidence in one short sentence.",
            model: liveAgentModel.model,
            runtime: {
              ...liveAgentModel.runtime,
              toolRequests: [
                {
                  effect: "read",
                  idempotencyKey: `${runKey}:brain-search`,
                  input: {
                    brainIds: [brainId],
                    limit: 5,
                    query: `When does the ${marker} release train ship?`,
                  },
                  inputSummary: searchSummary,
                  requiredScopes: [],
                  toolName: "agent.brain.search",
                },
              ],
            },
            sandbox: { mode: "none" },
            triggers: ["api"],
          },
        },
        { serviceAccountScopes: ["brains:read"] },
      );
      const runtimeAuth = tenantHeaders(agent.runtimeApiKey, config);

      const memberGrant = json(
        yield* api.request({
          body: {
            permission: "reader",
            target: { organizationRole: "member", type: "organization-role" },
          },
          idempotencyKey: `${runKey}:grant:member`,
          method: "POST",
          path: `${brainPath}/grants`,
        }),
        201,
        "Brain organization-role grant",
      );
      const agentGrant = json(
        yield* api.request({
          body: {
            permission: "read-write",
            target: {
              agentDefinitionId: agent.definitionId,
              environmentId: config.environmentId,
              projectId: config.projectId,
              type: "agent-definition",
            },
          },
          idempotencyKey: `${runKey}:grant:agent`,
          method: "POST",
          path: `${brainPath}/grants`,
        }),
        201,
        "Brain agent-definition grant",
      );
      const serviceAccountGrant = json(
        yield* api.request({
          body: {
            permission: "read",
            target: {
              environmentId: config.environmentId,
              projectId: config.projectId,
              serviceAccountId: agent.serviceAccountId,
              type: "service-account",
            },
          },
          idempotencyKey: `${runKey}:grant:service-account`,
          method: "POST",
          path: `${brainPath}/grants`,
        }),
        201,
        "Brain service-account grant",
      );
      const grants = records(
        json(yield* api.request({ method: "GET", path: `${brainPath}/grants` }), 200, "grants")
          .items,
        "Brain grants",
      );
      expect(grants.filter((grant) => grant.status === "active").map((grant) => grant.id)).toEqual(
        expect.arrayContaining([memberGrant.id, agentGrant.id, serviceAccountGrant.id]),
      );
      expect(grants).toContainEqual(
        expect.objectContaining({ permission: "owner", status: "active" }),
      );

      const mount = json(
        yield* api.request({
          body: {
            agentDefinitionId: agent.definitionId,
            agentDeploymentId: agent.deploymentId,
            environmentId: config.environmentId,
            permission: "read-write",
            projectId: config.projectId,
          },
          idempotencyKey: `${runKey}:mount`,
          method: "POST",
          path: `${brainPath}/mounts`,
        }),
        201,
        "Brain mount",
      );
      expect(mount).toMatchObject({
        agentDeploymentId: agent.deploymentId,
        brainId,
        status: "active",
      });
      expect(
        records(
          json(yield* api.request({ method: "GET", path: `${brainPath}/mounts` }), 200, "mounts")
            .items,
          "Brain mounts",
        ).map((item) => item.id),
      ).toContain(mount.id);

      const source = json(
        yield* api.request({
          body: { kind: "upload", name: `E2E uploads ${runKey}` },
          idempotencyKey: `${runKey}:source`,
          method: "POST",
          path: `${brainPath}/sources`,
        }),
        201,
        "Brain upload source",
      );
      const sourcePath = `${brainPath}/sources/${stringField(source, "id", "Brain source")}`;
      const bytes = new TextEncoder().encode(
        [
          `# Release runbook ${marker}`,
          "",
          `The ${marker} release train ships every Thursday at 14:00 UTC after its canary holds for thirty minutes.`,
          `Owners of ${marker} must record the rollback plan before promotion.`,
          "",
        ].join("\n"),
      );
      const ticket = json(
        yield* api.request({
          body: {
            expectedByteSize: bytes.byteLength,
            expectedContentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            mediaType: "text/markdown",
          },
          idempotencyKey: `${runKey}:ticket`,
          method: "POST",
          path: `${sourcePath}/uploads`,
        }),
        201,
        "Brain upload ticket",
      );
      expect(ticket.status).toBe("issued");
      const uploaded = json(
        yield* api.upload({
          bytes,
          idempotencyKey: `${runKey}:content`,
          mediaType: "text/markdown",
          path: stringField(ticket, "uploadPath", "Brain upload ticket"),
        }),
        200,
        "Brain upload content",
      );
      expect(uploaded).toMatchObject({ id: ticket.id, status: "completed" });

      const captured = json(
        yield* api.request({
          body: {
            completedUploadTicketId: ticket.id,
            externalItemIdentity: `runbooks/${marker}.md`,
            kind: "content",
            mediaType: "text/markdown",
            sourceRevision: `${runKey}:revision:1`,
            title: `Release runbook ${marker}`,
          },
          idempotencyKey: `${runKey}:capture`,
          method: "POST",
          path: `${sourcePath}/documents`,
        }),
        201,
        "Brain document capture",
      );
      const document = record(captured.document, "captured document");
      const documentId = stringField(document, "id", "captured document");
      const versionId = stringField(record(captured.version, "version"), "id", "captured version");
      expect(document).toMatchObject({ currentContentVersionId: versionId, lifecycle: "active" });

      const health = yield* eventually(
        {
          intervalMs: 10_000,
          label: `Brain index health for ${documentId} (requires the organization's active Brain search placement)`,
          timeoutMs: 15 * 60_000,
        },
        api.request({ method: "GET", path: `${brainPath}/index-health?limit=100` }).pipe(
          Effect.flatMap((response) => {
            const item = records(json(response, 200, "index health").items, "index health").find(
              (candidate) =>
                candidate.documentId === documentId && candidate.documentVersionId === versionId,
            );
            return item?.status === "failed"
              ? Effect.fail(new Error(`Brain indexing failed: ${JSON.stringify(item)}`))
              : Effect.succeed(item?.status === "ready" ? item : undefined);
          }),
        ),
      );
      expect(records(health.components, "index components").map((c) => c.status)).not.toContain(
        "failed",
      );

      let searchAttempt = 0;
      const search = yield* eventually(
        { intervalMs: 5_000, label: "Brain search hit", timeoutMs: 5 * 60_000 },
        Effect.suspend(() =>
          api.request({
            body: {
              brainIds: [brainId],
              limit: 5,
              query: `When does the ${marker} release train ship?`,
            },
            idempotencyKey: `${runKey}:search:${String((searchAttempt += 1))}`,
            method: "POST",
            path: "/v1/brains/search",
          }),
        ).pipe(
          Effect.map((response) => {
            const body = json(response, 200, "Brain search");
            return records(body.results, "search results").some(
              (result) => record(result.citation, "citation").documentId === documentId,
            )
              ? body
              : undefined;
          }),
        ),
      );
      const searchAttemptId = stringField(search, "queryAttemptId", "Brain search");
      const hit = records(search.results, "search results").find(
        (result) => record(result.citation, "citation").documentId === documentId,
      )!;
      expect(hit.excerpt).toEqual(expect.stringContaining(marker));
      expect(record(hit.citation, "citation")).toMatchObject({
        brainId,
        documentVersionId: versionId,
        sourceId: source.id,
      });

      const answer = json(
        yield* api.request({
          body: { brainIds: [brainId], question: `When does the ${marker} release train ship?` },
          idempotencyKey: `${runKey}:ask`,
          method: "POST",
          path: "/v1/brains/ask",
        }),
        200,
        "Brain ask",
      );
      const askAttemptId = stringField(answer, "queryAttemptId", "Brain ask");
      expect(askAttemptId).not.toBe(searchAttemptId);
      expect(records(answer.claims, "Brain ask claims").length).toBeGreaterThan(0);
      expect(
        records(answer.usedCitations, "Brain ask citations").map((citation) => citation.documentId),
      ).toContain(documentId);

      const feedback = json(
        yield* api.request({
          body: {
            feedback: "The cited runbook answered the release cadence.",
            usefulness: "useful",
          },
          idempotencyKey: `${runKey}:feedback`,
          method: "POST",
          path: `/v1/brains/query-attempts/${askAttemptId}/feedback`,
        }),
        200,
        "Brain feedback",
      );
      expect(feedback).toMatchObject({ queryAttemptId: askAttemptId, usefulness: "useful" });

      const initialized = yield* brainMcp(api, `${runKey}:mcp:initialize`, "initialize", {
        capabilities: {},
        clientInfo: { name: "deployments-ai-e2e", version: "1.0.0" },
        protocolVersion: "2025-11-25",
      });
      expect(initialized.result).toMatchObject({
        capabilities: { tools: {} },
        serverInfo: { name: "deployments-ai-brain" },
      });
      expect(initialized.headers["mcp-session-id"]).toBe("deployments-ai-brain-v1");
      const listed = yield* brainMcp(api, `${runKey}:mcp:tools`, "tools/list");
      expect(
        records(listed.result.tools, "MCP tools")
          .map((tool) => stringField(tool, "name", "MCP tool"))
          .toSorted(),
      ).toEqual(BRAIN_MCP_TOOLS);
      const mcpSearch = brainToolOutput(
        (yield* brainMcp(api, `${runKey}:mcp:search`, "tools/call", {
          arguments: { brainIds: [brainId], query: `${marker} release train` },
          name: "brain.search",
        })).result,
        "MCP brain.search",
      );
      expect(mcpSearch.isError, mcpSearch.text).toBe(false);
      const mcpSearchPayload = record(mcpSearch.payload, "MCP brain.search payload");
      stringField(mcpSearchPayload, "queryAttemptId", "MCP brain.search payload");
      expect(
        records(mcpSearchPayload.results, "MCP search results").map(
          (result) => record(result.citation, "MCP citation").documentId,
        ),
      ).toContain(documentId);
      const mcpDocument = brainToolOutput(
        (yield* brainMcp(api, `${runKey}:mcp:document`, "tools/call", {
          arguments: { brainId, documentId },
          name: "brain.get_document",
        })).result,
        "MCP brain.get_document",
      );
      expect(mcpDocument.isError, mcpDocument.text).toBe(false);
      expect(record(mcpDocument.payload, "MCP document")).toMatchObject({
        document: { id: documentId },
        version: { id: versionId },
      });

      const submitted = json(
        yield* retryUnavailableHttpRequest(
          "Brain run submit",
          http.request({
            body: {
              content: `When does the ${marker} release train ship? Answer in one short sentence.`,
            },
            headers: { ...runtimeAuth, "idempotency-key": `${runKey}:run` },
            method: "POST",
            path: `/v1/agent-deployments/${agent.deploymentId}/runs`,
            timeoutMs: 60_000,
          }),
        ),
        202,
        "Brain run submit",
      );
      const runId = stringField(record(submitted.run, "submitted.run"), "id", "submitted.run");
      const threadId = stringField(
        record(submitted.thread, "submitted.thread"),
        "id",
        "submitted.thread",
      );
      yield* eventually(
        { label: `Brain run ${runId}`, timeoutMs: 300_000 },
        http
          .request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/threads/${threadId}/runs/${runId}`,
          })
          .pipe(
            Effect.map((response) => {
              const current = json(response, 200, "Brain run");
              if (current.status === "failed")
                throw new Error(`Brain run failed: ${response.body}`);
              return current.status === "completed" ? current : undefined;
            }),
          ),
      );
      expect(
        json(
          yield* http.request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/runs/${runId}/tool-calls`,
          }),
          200,
          "Brain run tool calls",
        ).toolCalls,
      ).toEqual([
        expect.objectContaining({
          inputSummary: searchSummary,
          policyAction: "allow",
          status: "succeeded",
          toolName: "agent.brain.search",
        }),
      ]);
      const reply = records(
        json(
          yield* http.request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/threads/${threadId}/messages`,
          }),
          200,
          "Brain run messages",
        ).messages,
        "Brain run messages.messages",
      ).findLast((message) => message.role === "assistant" && message.runId === runId);
      const publicationId = stringField(
        record(reply?.metadata, "Brain reply metadata"),
        "brainPublicationArtifactId",
        "Brain reply metadata",
      );
      expect(reply).toMatchObject({
        metadata: { brainIds: [brainId], kind: "brain-private-publication-link" },
      });
      expect(reply?.body).toContain(publicationId);
      expect(reply?.body).not.toMatch(/thursday/iu);
      expect(
        json(
          yield* http.request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/artifacts/${publicationId}`,
          }),
          200,
          "Brain publication artifact",
        ),
      ).toMatchObject({
        metadata: {
          source: {
            brainIds: [brainId],
            citations: expect.arrayContaining([
              expect.objectContaining({
                brainId,
                documentId,
                documentVersionId: versionId,
                sourceId: source.id,
              }),
            ]),
            initiatingServiceAccountId: agent.serviceAccountId,
            kind: "brain-private-publication",
          },
        },
        runId,
        type: "brain-private-publication",
        visibility: "private",
      });
      const publicationAccess = json(
        yield* http.request({
          body: { expiresInSeconds: 60 },
          headers: runtimeAuth,
          method: "POST",
          path: `/v1/artifacts/${publicationId}/access-urls`,
        }),
        201,
        "Brain publication access URL",
      );
      const publishedAnswer = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(
            stringField(publicationAccess, "url", "Brain publication access"),
            { signal: AbortSignal.timeout(30_000) },
          );
          if (!response.ok) {
            throw new Error(`Brain publication GET returned ${String(response.status)}.`);
          }
          return await response.text();
        },
        catch: (cause) => new Error("Brain publication download failed.", { cause }),
      });
      expect(publishedAnswer).toMatch(/thursday/iu);

      const current = json(yield* api.request({ method: "GET", path: brainPath }), 200, "Brain");
      const erasure = json(
        yield* api.request({
          body: { expectedVersion: numberField(current, "version", "Brain") },
          idempotencyKey: `${runKey}:erasure`,
          method: "POST",
          path: `${brainPath}/erasures`,
        }),
        202,
        "Brain erasure",
      );
      expect(erasure).toMatchObject({ brainId, status: "pending" });
      const erasurePath = `${brainPath}/erasures/${stringField(erasure, "id", "Brain erasure")}`;
      const completed = yield* eventually(
        { intervalMs: 20_000, label: "Brain erasure completion", timeoutMs: 35 * 60_000 },
        api.request({ method: "GET", path: erasurePath }).pipe(
          Effect.map((response) => {
            const receipt = json(response, 200, "Brain erasure receipt");
            return receipt.status === "completed" ? receipt : undefined;
          }),
        ),
      );
      expect(completed).toMatchObject({ brainId, contentVerificationCount: 2 });
      expect(numberField(completed, "recordsDeleted", "Brain erasure")).toBeGreaterThan(0);
      expect(record(completed.searchReceipt, "Brain erasure search receipt")).toHaveProperty(
        "brainSearch",
      );

      expect(
        problemCode(yield* api.request({ method: "GET", path: brainPath }), 404, "erased"),
      ).toBe("brain_not_found");
      expect(
        (yield* api.request({ method: "GET", path: `${brainPath}/documents/${documentId}` }))
          .status,
      ).toBe(404);
      for (const [route, body] of [
        ["search", { brainIds: [brainId], query: `${marker} release train` }],
        ["ask", { brainIds: [brainId], question: `When does the ${marker} release train ship?` }],
      ] as const) {
        expect(
          problemCode(
            yield* api.request({
              body,
              idempotencyKey: `${runKey}:erased:${route}`,
              method: "POST",
              path: `/v1/brains/${route}`,
            }),
            404,
            `erased Brain ${route}`,
          ),
        ).toBe("brain_query_scope_not_found");
      }
      for (const [name, args] of [
        ["brain.get_document", { brainId, documentId }],
        ["brain.search", { brainIds: [brainId], query: `${marker} release train` }],
      ] as const) {
        const erased = brainToolOutput(
          (yield* brainMcp(api, `${runKey}:mcp:erased:${name}`, "tools/call", {
            arguments: args,
            name,
          })).result,
          `erased MCP ${name}`,
        );
        expect(erased.isError, `erased MCP ${name}: ${erased.text}`).toBe(true);
        expect(erased.text).not.toContain(marker);
      }
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  60 * 60_000,
);
