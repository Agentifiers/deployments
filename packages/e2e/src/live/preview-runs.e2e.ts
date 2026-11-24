import type {
  AgentDeploymentResponse,
  AgentDefinitionSummaryResponse,
  AgentReleaseResponse,
} from "@deployments-ai/api-contract/agents";
import type {
  PreviewResponse,
  RunResponse,
  SubmitPreviewTurnRequest,
  ThreadResponse,
} from "@deployments-ai/api-contract/runtime";
import {
  PlatformApiError,
  createPlatformSdk,
  type CreatePreviewInput,
  type PlatformContext,
  type PlatformResponse,
  type PlatformSdk,
  type RuntimeSdk,
} from "@agentifiers/deployments-sdk";
import { expect, it } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import { acquireRuntimeCredential } from "../harness/live-agent.ts";
import { credentialedE2eEnabled, scopedE2eConfig } from "../harness/live-config.ts";
import { liveAgentModel } from "../harness/live-model.ts";

const enabled = credentialedE2eEnabled();
const MAX_LISTING_PAGES = 50;

interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string | null | undefined;
}

function failure(label: string, cause: unknown) {
  const detail =
    cause instanceof PlatformApiError
      ? `HTTP ${String(cause.problem.status)} ${cause.problem.code ?? ""}: ${cause.message}`
      : cause instanceof Error
        ? cause.message
        : String(cause);
  return new Error(`${label} failed: ${detail}`, { cause });
}

function call<T>(label: string, request: () => Promise<PlatformResponse<T>>) {
  return Effect.tryPromise({
    try: async () => (await request()).data,
    catch: (cause) => failure(label, cause),
  });
}

/** Retries only 503 responses; every mutation carries an idempotency key, so repeats are safe. */
function callRetryingUnavailable<T>(label: string, request: () => Promise<PlatformResponse<T>>) {
  return eventually(
    { label, timeoutMs: 15_000 },
    Effect.tryPromise({
      try: async () => {
        try {
          return (await request()).data;
        } catch (cause) {
          if (cause instanceof PlatformApiError && cause.problem.status === 503) return undefined;
          throw cause;
        }
      },
      catch: (cause) => failure(label, cause),
    }),
  );
}

function collectPages<T>(label: string, page: (cursor?: string) => Promise<Page<T>>) {
  return Effect.tryPromise({
    try: async () => {
      const items: T[] = [];
      let cursor: string | undefined;
      for (let index = 0; index < MAX_LISTING_PAGES; index += 1) {
        const current = await page(cursor);
        items.push(...current.items);
        if (!current.nextCursor) return items;
        cursor = current.nextCursor;
      }
      throw new Error(`${label} exceeded ${String(MAX_LISTING_PAGES)} pages.`);
    },
    catch: (cause) => failure(label, cause),
  });
}

function agentResourceListing<T>(
  sdk: PlatformSdk,
  context: PlatformContext,
  path: "/v1/agent-definitions" | "/v1/agent-deployments",
) {
  return collectPages(`${path} listing`, async (cursor) => {
    const { data } = await sdk.request<Page<T>>({
      context,
      method: "GET",
      path,
      query: { cursor, limit: 100 },
    });
    return data;
  });
}

function expectPreviewRun(run: RunResponse, preview: PreviewResponse, threadId: string) {
  expect(run, `preview run ${run.id}`).toMatchObject({
    executionBindingId: preview.id,
    executionPurpose: "preview",
    status: "completed",
    threadId,
  });
  expect(run.agentDeploymentId).toBeUndefined();
  expect(run.agentReleaseId).toBeUndefined();
}

function expectPreviewThread(thread: ThreadResponse, preview: PreviewResponse) {
  expect(thread).toMatchObject({ executionBindingId: preview.id, executionPurpose: "preview" });
  expect(thread.agentDeploymentId).toBeUndefined();
}

/** Submits one preview turn, then waits for its run to settle and proves it ran as a preview. */
function completedPreviewTurn(
  runtime: RuntimeSdk,
  preview: PreviewResponse,
  input: typeof SubmitPreviewTurnRequest.Encoded,
  idempotencyKey: string,
) {
  return Effect.gen(function* () {
    const submitted = yield* callRetryingUnavailable(`preview turn ${idempotencyKey}`, () =>
      runtime.previews.submitTurn(preview.id, input, { idempotencyKey }),
    );
    expect(submitted.created).toBe(true);
    expectPreviewThread(submitted.thread, preview);
    const settled = yield* eventually(
      { label: `preview run ${submitted.run.id}`, timeoutMs: 180_000 },
      call("preview run read", () => runtime.runs.get(submitted.thread.id, submitted.run.id)).pipe(
        Effect.map((run) =>
          ["canceled", "completed", "failed"].includes(run.status) ? run : undefined,
        ),
      ),
    );
    expectPreviewRun(settled, preview, submitted.thread.id);
    return submitted;
  });
}

it.effect.skipIf(!enabled)(
  "proves preview turns execute an unpublished manifest in isolation from releases and deployments",
  () =>
    Effect.gen(function* () {
      const config = yield* scopedE2eConfig;
      const cli = yield* CliProcess;
      const runKey = `e2e-preview-${randomUUID()}`;
      const credential = yield* acquireRuntimeCredential(cli, config, runKey);
      const context: PlatformContext = {
        environmentId: config.environmentId,
        organizationId: config.organizationId,
        projectId: config.projectId,
      };
      const sdk = createPlatformSdk({ apiKey: credential.runtimeApiKey, baseUrl: config.apiUrl });
      const runtime = sdk.runtime(context);
      const manifest = {
        apiVersion: "agents.deployments.ai/v1",
        kind: "Agent",
        metadata: { key: runKey, name: `E2E preview ${runKey}`, version: "1.0.0" },
        spec: {
          capabilities: { tools: [] },
          instructions: "Reply with one short sentence confirming the preview turn you received.",
          model: liveAgentModel.model,
          runtime: liveAgentModel.runtime,
          sandbox: { mode: "none" },
          triggers: ["api"],
        },
      } satisfies CreatePreviewInput["manifest"];

      const deploymentsBefore = new Set(
        (yield* agentResourceListing<AgentDeploymentResponse>(
          sdk,
          context,
          "/v1/agent-deployments",
        )).map((deployment) => deployment.id),
      );

      const preview = yield* Effect.acquireRelease(
        callRetryingUnavailable("preview create", () =>
          runtime.previews.create(
            { manifest, ttlSeconds: 3_600 },
            { idempotencyKey: `${runKey}:preview` },
          ),
        ),
        (created) =>
          call("preview cleanup", () => runtime.previews.delete(created.id)).pipe(
            Effect.catch((error) =>
              error.cause instanceof PlatformApiError && error.cause.problem.status === 404
                ? Effect.void
                : Effect.die(error),
            ),
          ),
      );
      expect(preview).toMatchObject({
        agentName: manifest.metadata.name,
        environmentId: config.environmentId,
        object: "preview",
        organizationId: config.organizationId,
        projectId: config.projectId,
        status: "active",
      });
      expect(Date.parse(preview.expiresAt)).toBeGreaterThan(Date.now());
      expect(yield* call("preview read", () => runtime.previews.get(preview.id))).toMatchObject({
        contentHash: preview.contentHash,
        id: preview.id,
        status: "active",
      });

      const first = yield* completedPreviewTurn(
        runtime,
        preview,
        { content: `Confirm preview turn one for ${runKey}.` },
        `${runKey}:turn:1`,
      );
      const threadId = first.thread.id;
      const second = yield* completedPreviewTurn(
        runtime,
        preview,
        { content: `Confirm preview turn two for ${runKey}.`, threadId },
        `${runKey}:turn:2`,
      );
      expect(second.thread.id).toBe(threadId);
      expect(second.run.id).not.toBe(first.run.id);

      const messages = yield* call("preview thread messages", () =>
        runtime.threads.listMessages(threadId, { limit: 100 }),
      );
      expect(messages.messages.filter((message) => message.role === "user")).toHaveLength(2);
      expect(
        messages.messages.filter((message) => message.role === "assistant").length,
      ).toBeGreaterThanOrEqual(2);

      const bindingRuns = yield* call("preview run listing", () =>
        runtime.runs.list({ executionBindingId: preview.id, limit: 100 }),
      );
      expect(bindingRuns.runs.map((run) => run.id).toSorted()).toEqual(
        [first.run.id, second.run.id].toSorted(),
      );
      for (const run of bindingRuns.runs) expectPreviewRun(run, preview, threadId);

      const bindingThreads = yield* call("preview thread listing", () =>
        runtime.threads.list({ executionBindingId: preview.id, limit: 100 }),
      );
      expect(bindingThreads.threads.map((thread) => thread.id)).toEqual([threadId]);
      expectPreviewThread(bindingThreads.threads[0]!, preview);
      const defaultThreads = yield* collectPages("default thread listing", async (cursor) => {
        const { data } = await runtime.threads.list({ limit: 100, ...(cursor ? { cursor } : {}) });
        return { items: data.threads, nextCursor: data.nextCursor };
      });
      expect(defaultThreads.map((thread) => thread.id)).not.toContain(threadId);

      const definitions = yield* agentResourceListing<AgentDefinitionSummaryResponse>(
        sdk,
        context,
        "/v1/agent-definitions",
      );
      expect(
        definitions.filter((definition) => definition.name === manifest.metadata.name),
      ).toEqual([]);
      const newDeployments = (yield* agentResourceListing<AgentDeploymentResponse>(
        sdk,
        context,
        "/v1/agent-deployments",
      )).filter((deployment) => !deploymentsBefore.has(deployment.id));
      for (const deployment of newDeployments) {
        const release = yield* call("concurrent deployment release read", () =>
          sdk.request<AgentReleaseResponse>({
            context,
            method: "GET",
            path: `/v1/agent-releases/${encodeURIComponent(deployment.agentReleaseId)}`,
          }),
        );
        expect(release.contentHash, `deployment ${deployment.id}`).not.toBe(preview.contentHash);
      }

      const expired = yield* call("preview delete", () => runtime.previews.delete(preview.id));
      expect(expired).toMatchObject({ id: preview.id, status: "expired" });
      expect(expired.expiredAt).toEqual(expect.any(String));
      expect(
        yield* call("expired preview read", () => runtime.previews.get(preview.id)),
      ).toMatchObject({ id: preview.id, status: "expired" });

      const rejected = yield* Effect.promise(() =>
        runtime.previews
          .submitTurn(
            preview.id,
            { content: `Attempt a turn on the expired preview ${runKey}.`, threadId },
            { idempotencyKey: `${runKey}:turn:expired` },
          )
          .then(
            () => undefined,
            (cause: unknown) => cause,
          ),
      );
      expect(rejected).toBeInstanceOf(PlatformApiError);
      expect((rejected as PlatformApiError).problem).toMatchObject({
        code: "execution_binding_expired",
        status: 409,
      });
    }).pipe(Effect.provide(CliProcessLive)),
  600_000,
);
