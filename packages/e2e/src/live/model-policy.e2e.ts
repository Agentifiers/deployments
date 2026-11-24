import { expect, it } from "@effect/vitest";
import {
  ListModelsResponse,
  ModelPolicyResponse,
  type ModelCatalogItem,
} from "@deployments-ai/api-contract/models";
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import {
  E2eHttpClient,
  httpClientLayer,
  type E2eHttpClientService,
} from "../harness/http-client.ts";
import {
  acquireLiveAgent,
  cleanupHttpRequest,
  record,
  retryUnavailableHttpRequest,
  stringField,
} from "../harness/live-agent.ts";
import { json } from "../harness/response-records.ts";
import { credentialedE2eEnabled, e2eApiUrl, scopedE2eConfig } from "../harness/live-config.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";

type Headers = Readonly<Record<string, string>>;

const enabled = credentialedE2eEnabled();
const MINIMUM_CONTEXT_WINDOW_TOKENS = 32_000;
const decodeModels = Schema.decodeUnknownSync(ListModelsResponse);
const decodePolicy = Schema.decodeUnknownSync(ModelPolicyResponse);

/** What this run changed on the environment's model policy, so cleanup can undo only that. */
interface PolicyLease {
  readonly addedModel: boolean;
  readonly created: boolean;
  readonly policyId: string;
  readonly widenedCurated: boolean;
}

function listModels(
  http: E2eHttpClientService,
  auth: Headers,
  filters: Record<string, string>,
  maxItems = Number.POSITIVE_INFINITY,
) {
  return Effect.gen(function* () {
    const items: ModelCatalogItem[] = [];
    const limit = String(Math.min(100, maxItems));
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ ...filters, limit, ...(cursor ? { cursor } : {}) });
      const page = decodeModels(
        json(
          yield* retryUnavailableHttpRequest(
            "model catalog list",
            http.request({ headers: auth, method: "GET", path: `/v1/models?${query.toString()}` }),
          ),
          200,
          "model catalog list",
        ),
      );
      items.push(...page.items);
      cursor = items.length < maxItems ? page.nextCursor : null;
    } while (cursor);
    return items;
  });
}

function activePolicyId(http: E2eHttpClientService, auth: Headers) {
  return http.request({ headers: auth, method: "GET", path: "/v1/models?limit=1" }).pipe(
    Effect.map((response) => {
      const { policy } = decodeModels(json(response, 200, "effective model policy"));
      return policy.source === "model_policy" ? policy.modelPolicyId : undefined;
    }),
  );
}

/**
 * Admits `modelId` in the shared environment without clobbering it: create a policy (curated models
 * plus `modelId`) only when none is active, otherwise extend the active policy. Concurrent writers
 * surface as HTTP 409 and are retried against a fresh read.
 */
function admitModel(http: E2eHttpClientService, auth: Headers, runKey: string, modelId: string) {
  return eventually(
    { label: `model policy admission of ${modelId}`, timeoutMs: 60_000 },
    Effect.gen(function* () {
      const policyId = yield* activePolicyId(http, auth);
      if (!policyId) {
        const response = yield* retryUnavailableHttpRequest(
          "model policy create",
          http.request({
            body: {
              description: `Credentialed E2E model admission ${runKey}`,
              includeCuratedModels: true,
              models: [modelId],
              name: `E2E model policy ${runKey.slice(-12)}`,
            },
            headers: { ...auth, "idempotency-key": `${runKey}:policy:create` },
            method: "POST",
            path: "/v1/model-policies",
          }),
        );
        if (response.status === 409) return undefined;
        const created = decodePolicy(json(response, 201, "model policy create"));
        expect(created).toMatchObject({ includeCuratedModels: true, models: [modelId] });
        return { addedModel: true, created: true, policyId: created.id, widenedCurated: false };
      }
      const current = decodePolicy(
        json(
          yield* http.request({
            headers: auth,
            method: "GET",
            path: `/v1/model-policies/${policyId}`,
          }),
          200,
          "active model policy",
        ),
      );
      const lease: PolicyLease = {
        addedModel: !current.models.includes(modelId),
        created: false,
        policyId,
        widenedCurated: !current.includeCuratedModels,
      };
      if (!lease.addedModel && !lease.widenedCurated) return lease;
      const response = yield* retryUnavailableHttpRequest(
        "model policy update",
        http.request({
          body: {
            expectedVersion: current.version,
            includeCuratedModels: true,
            models: lease.addedModel ? [...current.models, modelId] : current.models,
          },
          headers: { ...auth, "idempotency-key": `${runKey}:policy:update:${current.version}` },
          method: "PATCH",
          path: `/v1/model-policies/${policyId}`,
        }),
      );
      if (response.status === 409) return undefined;
      expect(decodePolicy(json(response, 200, "model policy update")).models).toContain(modelId);
      return lease;
    }),
  );
}

/** Reverts exactly this run's policy change while keeping any concurrent writer's rules. */
function releaseModel(
  http: E2eHttpClientService,
  auth: Headers,
  runKey: string,
  modelId: string,
  lease: PolicyLease,
) {
  if (!lease.created && !lease.addedModel && !lease.widenedCurated) return Effect.void;
  return eventually(
    { label: `model policy restore for ${modelId}`, timeoutMs: 60_000 },
    Effect.gen(function* () {
      const read = yield* http.request({
        headers: auth,
        method: "GET",
        path: `/v1/model-policies/${lease.policyId}`,
      });
      if (read.status === 404) return true;
      const current = decodePolicy(json(read, 200, "model policy restore read"));
      if (current.status !== "active") return true;
      const models = current.models.filter((entry) => !lease.addedModel || entry !== modelId);
      const archive = lease.created && models.length === 0 && current.includeCuratedModels;
      const response = yield* retryUnavailableHttpRequest(
        "model policy restore",
        http.request({
          body: archive
            ? { expectedVersion: current.version }
            : {
                expectedVersion: current.version,
                includeCuratedModels: lease.widenedCurated ? false : current.includeCuratedModels,
                models,
              },
          headers: { ...auth, "idempotency-key": `${runKey}:policy:restore:${current.version}` },
          method: archive ? "DELETE" : "PATCH",
          path: `/v1/model-policies/${lease.policyId}`,
        }),
      );
      if (response.status === 409) return undefined;
      json(response, 200, "model policy restore");
      return true;
    }),
  ).pipe(Effect.asVoid, Effect.orDie);
}

function agentManifest(runKey: string, modelId: string) {
  return {
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: runKey, name: `E2E model policy ${runKey}`, version: "1.0.0" },
    spec: {
      capabilities: { tools: [] },
      instructions:
        "Reply with one short sentence confirming the request and do not request tools.",
      model: { id: modelId },
      sandbox: { mode: "none" },
      triggers: ["api"],
    },
  };
}

function cleanupDefinition(http: E2eHttpClientService, auth: Headers, id: string, key: string) {
  return http.request({ headers: auth, method: "GET", path: `/v1/agent-definitions/${id}` }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 404) return Effect.void;
      const current = json(response, 200, "denied agent definition cleanup read");
      return cleanupHttpRequest(
        "denied agent definition",
        http.request({
          body: { expectedVersion: current.version },
          headers: { ...auth, "idempotency-key": key },
          method: "DELETE",
          path: `/v1/agent-definitions/${id}`,
        }),
      );
    }),
    Effect.orDie,
  );
}

it.effect.skipIf(!enabled)(
  "admits a policy-allowed catalog model through publish, deploy, and run while rejecting others",
  () =>
    Effect.gen(function* () {
      const config = yield* scopedE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const runKey = `e2e-model-policy-${randomUUID()}`;
      const auth = tenantHeaders(config.platformCredential, config);

      // The openai provider is the deployment's relay in dev, so the admitted model runs there and
      // is priced from the catalog without manifest budgets.
      const toolCallingCatalog = yield* listModels(http, auth, {
        capability: "tool_calling",
        curated: "false",
        provider: "openai",
      });
      expect(toolCallingCatalog.length, "non-curated OpenAI tool-calling models").toBeGreaterThan(
        0,
      );
      for (const item of toolCallingCatalog) {
        expect(item).toMatchObject({
          capabilities: { toolCalling: true },
          curated: false,
          provider: "openai",
        });
      }
      // Cheapest paid model; ties break on the model id for determinism.
      const [chosen] = toolCallingCatalog
        .filter(
          (item) =>
            item.contextWindowTokens >= MINIMUM_CONTEXT_WINDOW_TOKENS &&
            (item.pricing?.outputUsdPerMillionTokens ?? 0) > 0,
        )
        .sort(
          (left, right) =>
            left.pricing!.outputUsdPerMillionTokens - right.pricing!.outputUsdPerMillionTokens ||
            left.modelId.localeCompare(right.modelId),
        );
      if (!chosen)
        throw new Error("No paid non-curated OpenAI tool-calling model has 32k context.");
      const modelId = chosen.modelId;

      const lease = yield* Effect.acquireRelease(
        admitModel(http, auth, runKey, modelId),
        (acquired) => releaseModel(http, auth, runKey, modelId, acquired),
      );
      const [admitted] = (yield* listModels(http, auth, { search: modelId })).filter(
        (item) => item.modelId === modelId,
      );
      expect(admitted).toMatchObject({ allowed: true, curated: false, modelId });

      // The deployment-wide operator grant admits relayed openai models at publish whatever the
      // policy says, so the denied model comes from OpenRouter. It is only published, never run.
      const [denied] = yield* listModels(
        http,
        auth,
        { allowed: "false", curated: "false", provider: "openrouter" },
        1,
      );
      if (!denied) {
        throw new Error(
          `Model policy ${lease.policyId} admits every OpenRouter catalog model; denial cannot be proven without narrowing shared rules.`,
        );
      }

      const agent = yield* acquireLiveAgent(cli, config, runKey, agentManifest(runKey, modelId));
      const runtimeAuth = tenantHeaders(agent.runtimeApiKey, config);
      const submitted = json(
        yield* retryUnavailableHttpRequest(
          "model policy run submit",
          http.request({
            body: {
              content: `Confirm the model policy proof ${runKey}.`,
              title: `Model policy proof ${runKey}`,
            },
            headers: { ...runtimeAuth, "idempotency-key": `${runKey}:run` },
            method: "POST",
            path: `/v1/agent-deployments/${agent.deploymentId}/runs`,
            timeoutMs: 60_000,
          }),
        ),
        202,
        "model policy run submit",
      );
      const runId = stringField(record(submitted.run, "submitted run"), "id", "submitted run");
      const threadId = stringField(record(submitted.thread, "thread"), "id", "thread");
      const completed = yield* eventually(
        { label: `completed ${modelId} run ${runId}`, timeoutMs: 240_000 },
        http
          .request({
            headers: runtimeAuth,
            method: "GET",
            path: `/v1/threads/${threadId}/runs/${runId}`,
          })
          .pipe(
            Effect.map((response) => {
              const current = json(response, 200, "model policy run get");
              if (current.status === "failed" || current.status === "canceled") {
                throw new Error(`Run on ${modelId} did not complete: ${response.body}`);
              }
              return current.status === "completed" ? current : undefined;
            }),
          ),
      );
      expect(completed).toMatchObject({ id: runId, status: "completed" });
      const messages = json(
        yield* http.request({
          headers: runtimeAuth,
          method: "GET",
          path: `/v1/threads/${threadId}/messages`,
        }),
        200,
        "model policy run messages",
      ).messages;
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ body: expect.stringMatching(/\S/u), role: "assistant", runId }),
        ]),
      );

      const deniedDefinition = yield* Effect.acquireRelease(
        http
          .request({
            body: { manifest: agentManifest(`${runKey}-denied`, denied.modelId) },
            headers: { ...auth, "idempotency-key": `${runKey}:denied-agent` },
            method: "POST",
            path: "/v1/agent-definitions",
          })
          .pipe(Effect.map((response) => json(response, 201, "denied agent definition create"))),
        (created) =>
          cleanupDefinition(
            http,
            auth,
            stringField(created, "id", "denied agent definition"),
            `${runKey}:denied-agent:archive`,
          ),
      );
      const deniedPublish = yield* http.request({
        body: { expectedDefinitionVersion: deniedDefinition.version },
        headers: { ...auth, "idempotency-key": `${runKey}:denied-release` },
        method: "POST",
        path: `/v1/agent-definitions/${stringField(deniedDefinition, "id", "denied agent definition")}/releases`,
      });
      expect(deniedPublish.status, deniedPublish.body).toBe(422);
      expect(record(deniedPublish.json, "denied publish problem")).toMatchObject({
        code: "model_not_allowed_by_environment_policy",
      });
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  420_000,
);
