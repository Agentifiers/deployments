import { expect } from "@effect/vitest";
import { createHash } from "node:crypto";
import { Effect } from "effect";
import { eventually } from "../harness/eventually.ts";
import type { E2eHttpClientService, HttpResult } from "../harness/http-client.ts";
import {
  cleanupHttpResult,
  numberField,
  record,
  retryUnavailableHttpRequest,
  stringField,
} from "../harness/live-agent.ts";
import { liveAgentModel } from "../harness/live-model.ts";

type JsonRecord = Record<string, unknown>;
type Headers = Readonly<Record<string, string>>;

/** HTTP client plus credential and idempotency prefix for one tenant environment. */
export interface ReleaseLifecycleClient {
  readonly auth: Headers;
  readonly http: E2eHttpClientService;
  readonly runKey: string;
}

export interface SubmittedTurn {
  readonly run: JsonRecord;
  readonly runId: string;
  readonly threadId: string;
}

export function expectJson(response: HttpResult, status: number, label: string) {
  expect(response.status, `${label}: ${response.body}`).toBe(status);
  return record(response.json, label);
}

export function jsonRecords(value: unknown, label: string) {
  if (!Array.isArray(value)) throw new TypeError(`${label} was not an array.`);
  return value.map((entry, index) => record(entry, `${label}[${index}]`));
}

/** Mirrors the server's deterministic per-thread canary bucket in [0, 100). */
function canaryBucket(deploymentId: string, threadId: string) {
  return (
    createHash("sha256").update(`canary-v1|${deploymentId}|${threadId}`).digest().readUInt32BE(0) %
    100
  );
}

export function releaseManifest(
  key: string,
  instructions: string,
  {
    runtime,
    ...spec
  }: {
    readonly runtime?: Readonly<Record<string, unknown>>;
    readonly [field: string]: unknown;
  } = {},
) {
  return {
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key, name: `E2E release lifecycle ${key}`, version: "1.0.0" },
    spec: {
      capabilities: { tools: [] },
      instructions,
      model: liveAgentModel.model,
      sandbox: { mode: "none" },
      triggers: ["api"],
      ...spec,
      runtime: { ...liveAgentModel.runtime, ...runtime },
    },
  };
}

function readVersion(client: ReleaseLifecycleClient, path: string, label: string) {
  return retryUnavailableHttpRequest(
    `${label} read`,
    client.http.request({ headers: client.auth, method: "GET", path }),
  ).pipe(
    Effect.map((response) =>
      response.status === 404
        ? undefined
        : numberField(expectJson(response, 200, `${label} read`), "version", label),
    ),
  );
}

/** Archives or stops a versioned tenancy resource through its DELETE route; missing is fine. */
export function cleanupVersionedResource(
  client: ReleaseLifecycleClient,
  options: { readonly key: string; readonly label: string; readonly path: string },
) {
  return readVersion(client, options.path, options.label).pipe(
    Effect.flatMap((version) =>
      version === undefined
        ? Effect.void
        : retryUnavailableHttpRequest(
            `${options.label} cleanup`,
            client.http.request({
              body: { expectedVersion: version },
              headers: { ...client.auth, "idempotency-key": options.key },
              method: "DELETE",
              path: options.path,
            }),
          ).pipe(Effect.flatMap((response) => cleanupHttpResult(options.label, response))),
    ),
    Effect.orDie,
  );
}

/**
 * Creates an agent definition whose published releases are archived after every resource
 * acquired later in the scope (deployments must stop before their releases can be archived).
 */
export function acquireAgentDefinition(
  client: ReleaseLifecycleClient,
  manifest: Readonly<Record<string, unknown>>,
) {
  return Effect.gen(function* () {
    const definition = yield* Effect.acquireRelease(
      client.http
        .request({
          body: { manifest },
          headers: { ...client.auth, "idempotency-key": `${client.runKey}:agent` },
          method: "POST",
          path: "/v1/agent-definitions",
        })
        .pipe(Effect.map((response) => expectJson(response, 201, "agent definition create"))),
      (created) =>
        cleanupVersionedResource(client, {
          key: `${client.runKey}:agent:archive`,
          label: "agent definition",
          path: `/v1/agent-definitions/${stringField(created, "id", "agent definition")}`,
        }),
    );
    const definitionId = stringField(definition, "id", "agent definition");
    const releaseIds: string[] = [];
    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        releaseIds.toReversed(),
        (releaseId) =>
          cleanupVersionedResource(client, {
            key: `${client.runKey}:release:${releaseId}:archive`,
            label: `agent release ${releaseId}`,
            path: `/v1/agent-releases/${releaseId}`,
          }),
        { discard: true },
      ),
    );

    /** Optionally replaces the draft manifest, then publishes it as a new release. */
    const publish = (label: string, nextManifest?: Readonly<Record<string, unknown>>) =>
      Effect.gen(function* () {
        const definitionPath = `/v1/agent-definitions/${definitionId}`;
        let expectedDefinitionVersion = yield* readVersion(client, definitionPath, label);
        if (expectedDefinitionVersion === undefined) {
          throw new Error(`Agent definition ${definitionId} disappeared before ${label}.`);
        }
        if (nextManifest) {
          const updated = expectJson(
            yield* client.http.request({
              body: { expectedVersion: expectedDefinitionVersion, manifest: nextManifest },
              headers: { ...client.auth, "idempotency-key": `${client.runKey}:${label}:draft` },
              method: "PATCH",
              path: definitionPath,
            }),
            200,
            `${label} draft update`,
          );
          expectedDefinitionVersion = numberField(updated, "version", `${label} draft`);
        }
        const release = expectJson(
          yield* client.http.request({
            body: { expectedDefinitionVersion },
            headers: { ...client.auth, "idempotency-key": `${client.runKey}:${label}:publish` },
            method: "POST",
            path: `${definitionPath}/releases`,
          }),
          201,
          `${label} publish`,
        );
        const releaseId = stringField(release, "id", label);
        releaseIds.push(releaseId);
        return release;
      });

    return { definitionId, publish };
  });
}

export function acquireDeployment(client: ReleaseLifecycleClient, agentReleaseId: string) {
  return Effect.acquireRelease(
    retryUnavailableHttpRequest(
      "agent deployment create",
      client.http.request({
        body: { agentReleaseId, desiredState: "running" },
        headers: { ...client.auth, "idempotency-key": `${client.runKey}:deployment` },
        method: "POST",
        path: "/v1/agent-deployments",
      }),
    ).pipe(Effect.map((response) => expectJson(response, 201, "agent deployment create"))),
    (created) =>
      cleanupVersionedResource(client, {
        key: `${client.runKey}:deployment:stop`,
        label: "agent deployment",
        path: `/v1/agent-deployments/${stringField(created, "id", "agent deployment")}`,
      }),
  );
}

/** Applies one versioned deployment mutation against the current deployment version. */
export function mutateDeployment(
  client: ReleaseLifecycleClient,
  deploymentId: string,
  options: {
    readonly body: Readonly<Record<string, unknown>>;
    readonly label: string;
    readonly method: "PATCH" | "POST";
    readonly suffix?: string;
  },
) {
  return Effect.gen(function* () {
    const path = `/v1/agent-deployments/${deploymentId}`;
    const expectedVersion = yield* readVersion(client, path, options.label);
    return expectJson(
      yield* client.http.request({
        body: { ...options.body, expectedVersion },
        headers: { ...client.auth, "idempotency-key": `${client.runKey}:${options.label}` },
        method: options.method,
        path: `${path}${options.suffix ?? ""}`,
      }),
      200,
      options.label,
    );
  });
}

export function submitTurn(
  runtime: ReleaseLifecycleClient,
  deploymentId: string,
  label: string,
  options: { readonly rebaseRelease?: boolean; readonly threadId?: string } = {},
) {
  return retryUnavailableHttpRequest(
    `${label} submit`,
    runtime.http.request({
      body: {
        content: `Reply with one short sentence confirming turn ${label}.`,
        ...(options.rebaseRelease === undefined ? {} : { rebaseRelease: options.rebaseRelease }),
        ...(options.threadId === undefined
          ? { title: `Release lifecycle ${label}` }
          : { threadId: options.threadId }),
      },
      headers: { ...runtime.auth, "idempotency-key": `${runtime.runKey}:${label}:run` },
      method: "POST",
      path: `/v1/agent-deployments/${deploymentId}/runs`,
      timeoutMs: 60_000,
    }),
  ).pipe(
    Effect.map((response): SubmittedTurn => {
      const submitted = expectJson(response, 202, `${label} submit`);
      const run = record(submitted.run, `${label}.run`);
      return {
        run,
        runId: stringField(run, "id", `${label}.run`),
        threadId: stringField(record(submitted.thread, `${label}.thread`), "id", `${label}.thread`),
      };
    }),
  );
}

export function readRun(runtime: ReleaseLifecycleClient, turn: SubmittedTurn) {
  return runtime.http
    .request({
      headers: runtime.auth,
      method: "GET",
      path: `/v1/threads/${turn.threadId}/runs/${turn.runId}`,
    })
    .pipe(Effect.map((response) => expectJson(response, 200, `run ${turn.runId}`)));
}

export function awaitRunStatus(
  runtime: ReleaseLifecycleClient,
  turn: SubmittedTurn,
  status: "completed" | "waiting-for-approval",
) {
  return eventually(
    { label: `run ${turn.runId} ${status}`, timeoutMs: 180_000 },
    readRun(runtime, turn).pipe(
      Effect.map((run) => {
        if (run.status === status) return run;
        if (["canceled", "completed", "failed"].includes(String(run.status))) {
          throw new Error(`Run ${turn.runId} ended ${String(run.status)} instead of ${status}.`);
        }
        return undefined;
      }),
    ),
  );
}

/** Submits a turn and waits for it to complete, returning the terminal run. */
export function completeTurn(
  runtime: ReleaseLifecycleClient,
  deploymentId: string,
  label: string,
  options: { readonly rebaseRelease?: boolean; readonly threadId?: string } = {},
) {
  return submitTurn(runtime, deploymentId, label, options).pipe(
    Effect.flatMap((turn) =>
      awaitRunStatus(runtime, turn, "completed").pipe(Effect.map((run) => ({ run, turn }))),
    ),
  );
}

export function readThread(runtime: ReleaseLifecycleClient, threadId: string) {
  return runtime.http
    .request({ headers: runtime.auth, method: "GET", path: `/v1/threads/${threadId}` })
    .pipe(Effect.map((response) => expectJson(response, 200, `thread ${threadId}`)));
}

function createThread(runtime: ReleaseLifecycleClient, deploymentId: string, title: string) {
  return runtime.http
    .request({
      body: { agentDeploymentId: deploymentId, title },
      headers: runtime.auth,
      method: "POST",
      path: "/v1/threads",
    })
    .pipe(
      Effect.map((response) =>
        stringField(expectJson(response, 201, `thread ${title}`), "id", "thread"),
      ),
    );
}

/**
 * Creates threads until one lands in the requested canary partition for `weight`. Each thread
 * has an independent uniform bucket, so the bounded attempt count makes a miss negligible.
 */
export function createThreadInPartition(
  runtime: ReleaseLifecycleClient,
  deploymentId: string,
  options: {
    readonly label: string;
    readonly partition: "candidate" | "primary";
    readonly weight: number;
  },
) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const threadId = yield* createThread(
        runtime,
        deploymentId,
        `Release lifecycle ${options.label} ${String(attempt)}`,
      );
      const candidate = canaryBucket(deploymentId, threadId) < options.weight;
      if (candidate === (options.partition === "candidate")) return threadId;
    }
    throw new Error(`No ${options.partition} thread found for ${options.label} in 32 attempts.`);
  });
}

export function listRunIds(
  runtime: ReleaseLifecycleClient,
  deploymentId: string,
  agentReleaseId: string,
) {
  const query = new URLSearchParams({
    agentDeploymentId: deploymentId,
    agentReleaseId,
    limit: "100",
  });
  return runtime.http
    .request({ headers: runtime.auth, method: "GET", path: `/v1/runs?${query.toString()}` })
    .pipe(
      Effect.map((response) =>
        jsonRecords(expectJson(response, 200, "run list").runs, "run list.runs").map((run) =>
          stringField(run, "id", "run list run"),
        ),
      ),
    );
}

export function searchRunIds(
  runtime: ReleaseLifecycleClient,
  deploymentId: string,
  agentReleaseId: string,
) {
  return runtime.http
    .request({
      body: { agentDeploymentId: deploymentId, agentReleaseId, limit: 100 },
      headers: runtime.auth,
      method: "POST",
      path: "/v1/runs/search",
    })
    .pipe(
      Effect.map((response) =>
        jsonRecords(expectJson(response, 200, "run search").runs, "run search.runs").map((run) =>
          stringField(run, "id", "run search run"),
        ),
      ),
    );
}

function pendingApprovals(runtime: ReleaseLifecycleClient, runId: string) {
  return runtime.http
    .request({ headers: runtime.auth, method: "GET", path: "/v1/approvals?status=pending" })
    .pipe(
      Effect.map((response) =>
        jsonRecords(
          expectJson(response, 200, "approval list").approvals ?? [],
          "approval list.approvals",
        ).filter((approval) => approval.runId === runId && approval.status === "pending"),
      ),
    );
}

export function awaitPendingApproval(runtime: ReleaseLifecycleClient, runId: string) {
  return eventually(
    { label: `approval for ${runId}`, timeoutMs: 180_000 },
    pendingApprovals(runtime, runId).pipe(Effect.map((approvals) => approvals[0])),
  );
}

/**
 * Approves the run's pending tool calls until it completes. The model may re-request the
 * approved tool, so each new approval is resolved within a small bound.
 */
export function approveUntilComplete(
  runtime: ReleaseLifecycleClient,
  turn: SubmittedTurn,
  firstApprovalId: string,
) {
  const seen = new Set<string>();
  const approve = (approvalId: string) => {
    seen.add(approvalId);
    if (seen.size > 4) {
      return Effect.die(new Error("Model exceeded the bounded approval proof loop."));
    }
    return runtime.http
      .request({
        body: { decision: "approved", threadId: turn.threadId },
        headers: runtime.auth,
        method: "POST",
        path: `/v1/runs/${turn.runId}/approvals/${approvalId}/resolve`,
      })
      .pipe(Effect.map((response) => expectJson(response, 200, "approval resolve")));
  };
  return approve(firstApprovalId).pipe(
    Effect.andThen(
      eventually(
        { label: `approved run ${turn.runId}`, timeoutMs: 180_000 },
        readRun(runtime, turn).pipe(
          Effect.flatMap((run) => {
            if (run.status === "completed") return Effect.succeed({ approvals: seen.size, run });
            if (["canceled", "failed"].includes(String(run.status))) {
              return Effect.die(
                new Error(`Approved run ${turn.runId} ended ${String(run.status)}.`),
              );
            }
            if (run.status !== "waiting-for-approval") return Effect.succeed(undefined);
            return pendingApprovals(runtime, turn.runId).pipe(
              Effect.flatMap((approvals) => {
                const next = approvals.find((approval) => !seen.has(String(approval.id)));
                return next
                  ? approve(stringField(next, "id", "repeated approval")).pipe(Effect.as(undefined))
                  : Effect.succeed(undefined);
              }),
            );
          }),
        ),
      ),
    ),
  );
}
