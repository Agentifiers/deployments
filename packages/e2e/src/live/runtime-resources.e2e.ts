import { expect, it } from "@effect/vitest";
import { createHash, randomUUID } from "node:crypto";
import { Effect } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import { E2eHttpClient, httpClientLayer } from "../harness/http-client.ts";
import {
  acquireLiveAgent,
  cleanupHttpRequest,
  record,
  retryUnavailableHttpRequest,
  stringField,
} from "../harness/live-agent.ts";
import { json } from "../harness/response-records.ts";
import { credentialedE2eEnabled, e2eApiUrl, featureE2eConfig } from "../harness/live-config.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";
import { liveAgentModel } from "../harness/live-model.ts";

const enabled = credentialedE2eEnabled();
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function deterministicAutomationId(seed: string, discriminator: string) {
  const bytes = createHash("sha256").update(`${seed}:${discriminator}`).digest().subarray(0, 10);
  let number = 0n;
  for (const byte of bytes) number = (number << 8n) | BigInt(byte);
  let suffix = "";
  for (let index = 0; index < 16; index += 1) {
    suffix = CROCKFORD[Number(number & 31n)]! + suffix;
    number >>= 5n;
  }
  return `${seed.slice(0, 10)}${suffix}`;
}

it.effect.skipIf(!enabled)(
  "proves artifact, webhook, schedule, and heartbeat lifecycles with durable side effects",
  () =>
    Effect.gen(function* () {
      const config = yield* featureE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const runKey = `e2e-resources-${randomUUID()}`;
      const manifest = {
        apiVersion: "agents.deployments.ai/v1",
        kind: "Agent",
        metadata: { key: runKey, name: `E2E resources ${runKey}`, version: "1.0.0" },
        spec: {
          capabilities: { tools: [] },
          instructions: "Reply with a short confirmation and do not request tools.",
          model: liveAgentModel.model,
          runtime: liveAgentModel.runtime,
          sandbox: { mode: "none" },
          triggers: ["api", "heartbeat", "schedule"],
        },
      };
      const agent = yield* acquireLiveAgent(cli, config, runKey, manifest);
      const auth = tenantHeaders(agent.runtimeApiKey, config);

      const artifactBody = Buffer.from(`artifact-proof:${runKey}`, "utf8");
      const artifactUpload = json(
        yield* http.request({
          body: {
            byteSize: artifactBody.byteLength,
            contentType: "text/plain",
            fileName: "proof.txt",
            metadata: { proof: runKey },
            name: `Artifact ${runKey}`,
            retentionExpiresAt: new Date(Date.now() + 20 * 60_000).toISOString(),
            sha256: createHash("sha256").update(artifactBody).digest("hex"),
            type: "e2e-proof",
            visibility: "organization",
          },
          headers: { ...auth, "idempotency-key": `${runKey}:artifact` },
          method: "POST",
          path: "/v1/artifacts",
        }),
        201,
        "artifact upload",
      );
      const pendingArtifact = record(artifactUpload.artifact, "artifact upload.artifact");
      const artifactId = stringField(pendingArtifact, "artifactId", "artifact");
      const upload = record(artifactUpload.upload, "artifact upload.upload");
      yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(stringField(upload, "url", "artifact upload"), {
            body: artifactBody,
            headers: upload.headers as Record<string, string>,
            method: "PUT",
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) {
            throw new Error(
              `Artifact PUT returned ${String(response.status)}: ${await response.text()}`,
            );
          }
        },
        catch: (cause) => new Error("Artifact byte upload failed.", { cause }),
      });
      const availableArtifact = json(
        yield* http.request({
          headers: auth,
          method: "POST",
          path: `/v1/artifacts/${artifactId}/complete`,
        }),
        200,
        "artifact complete",
      );
      expect(availableArtifact).toMatchObject({ artifactId, status: "available" });
      const access = json(
        yield* http.request({
          body: { expiresInSeconds: 60 },
          headers: auth,
          method: "POST",
          path: `/v1/artifacts/${artifactId}/access-urls`,
        }),
        201,
        "artifact access URL",
      );
      const downloaded = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(stringField(access, "url", "artifact access"), {
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok) throw new Error(`Artifact GET returned ${String(response.status)}.`);
          return Buffer.from(await response.arrayBuffer());
        },
        catch: (cause) => new Error("Artifact access URL download failed.", { cause }),
      });
      expect(downloaded.equals(artifactBody)).toBe(true);
      const currentArtifact = json(
        yield* http.request({
          headers: auth,
          method: "GET",
          path: `/v1/artifacts/${artifactId}`,
        }),
        200,
        "artifact after access",
      );
      expect(currentArtifact.version).toBe(Number(availableArtifact.version) + 1);
      const retained = json(
        yield* http.request({
          body: {
            expectedVersion: currentArtifact.version,
            retentionExpiresAt: new Date(
              Math.max(
                Date.parse(stringField(upload, "expiresAt", "artifact upload")),
                Date.parse(stringField(access, "expiresAt", "artifact access")),
              ) + 60_000,
            ).toISOString(),
          },
          headers: auth,
          method: "PATCH",
          path: `/v1/artifacts/${artifactId}/retention`,
        }),
        200,
        "artifact retention",
      );
      expect(retained.version).toBe(Number(currentArtifact.version) + 1);

      const schedule = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              agentDeploymentId: agent.deploymentId,
              expression: "at(2037-01-01T00:00:00)",
              name: `Schedule ${runKey}`,
              prompt: `Complete scheduled proof ${runKey}.`,
              timezone: "UTC",
            },
            headers: { ...auth, "idempotency-key": `${runKey}:schedule` },
            method: "POST",
            path: "/v1/schedules",
          })
          .pipe(Effect.map((response) => json(response, 201, "schedule create"))),
        (created) =>
          cleanupHttpRequest(
            "schedule",
            http.request({
              headers: auth,
              method: "DELETE",
              path: `/v1/schedules/${stringField(created, "id", "schedule")}`,
            }),
          ).pipe(Effect.orDie),
      );
      const scheduleId = stringField(schedule, "id", "schedule");
      const scheduleFireKey = `${runKey}:schedule-fire`;
      const scheduleFireId = deterministicAutomationId(scheduleId, scheduleFireKey);
      const webhook = yield* Effect.acquireRelease(
        http
          .request({
            body: {
              eventTypes: ["schedule.fired"],
              name: `Webhook ${runKey}`,
              resourceFilters: {
                aggregateIds: [scheduleFireId],
                environmentIds: [config.environmentId],
                projectIds: [config.projectId],
              },
              url: config.webhookUrl,
            },
            headers: { ...auth, "idempotency-key": `${runKey}:webhook` },
            method: "POST",
            path: "/v1/webhooks",
          })
          .pipe(Effect.map((response) => json(response, 201, "webhook create"))),
        (created) =>
          cleanupHttpRequest(
            "webhook",
            http.request({
              headers: auth,
              method: "POST",
              path: `/v1/webhooks/${stringField(created, "id", "webhook")}/archive`,
            }),
          ).pipe(Effect.orDie),
      );
      const webhookId = stringField(webhook, "id", "webhook");
      const pausedSchedule = json(
        yield* retryUnavailableHttpRequest(
          "schedule pause",
          http.request({
            headers: auth,
            method: "POST",
            path: `/v1/schedules/${scheduleId}/pause`,
          }),
        ),
        200,
        "schedule pause",
      );
      expect(pausedSchedule.status).toBe("paused");
      const resumedSchedule = json(
        yield* retryUnavailableHttpRequest(
          "schedule resume",
          http.request({
            headers: auth,
            method: "POST",
            path: `/v1/schedules/${scheduleId}/resume`,
          }),
        ),
        200,
        "schedule resume",
      );
      expect(resumedSchedule.status).toBe("active");
      const scheduleFire = json(
        yield* retryUnavailableHttpRequest(
          "schedule fire",
          http.request({
            body: { fireKey: scheduleFireKey },
            headers: { ...auth, "idempotency-key": `${runKey}:schedule-fire` },
            method: "POST",
            path: `/v1/schedules/${scheduleId}/fire`,
          }),
        ),
        202,
        "schedule fire",
      );
      expect(record(scheduleFire.fire, "schedule fire.fire").id).toBe(scheduleFireId);
      const scheduledRun = record(scheduleFire.run, "schedule fire.run");
      const scheduledRunId = stringField(scheduledRun, "runId", "schedule fire.run");
      const scheduledThreadId = stringField(scheduledRun, "threadId", "schedule fire.run");
      const scheduleReplay = json(
        yield* retryUnavailableHttpRequest(
          "schedule fire replay",
          http.request({
            body: { fireKey: scheduleFireKey },
            headers: { ...auth, "idempotency-key": `${runKey}:schedule-fire-replay` },
            method: "POST",
            path: `/v1/schedules/${scheduleId}/fire`,
          }),
        ),
        202,
        "schedule fire replay",
      );
      expect(scheduleReplay.duplicate).toBe(true);

      const heartbeat = yield* Effect.acquireRelease(
        retryUnavailableHttpRequest(
          "heartbeat create",
          http.request({
            body: {
              agentDeploymentId: agent.deploymentId,
              instructions: `Complete heartbeat proof ${runKey}.`,
              intervalMs: 10 * 60_000,
              skipWhenBusy: false,
              timezone: "UTC",
            },
            headers: { ...auth, "idempotency-key": `${runKey}:heartbeat` },
            method: "POST",
            path: "/v1/heartbeats",
          }),
        ).pipe(Effect.map((response) => json(response, 201, "heartbeat create"))),
        (created) =>
          cleanupHttpRequest(
            "heartbeat",
            http.request({
              headers: auth,
              method: "DELETE",
              path: `/v1/heartbeats/${stringField(created, "id", "heartbeat")}`,
            }),
          ).pipe(Effect.orDie),
      );
      const heartbeatId = stringField(heartbeat, "id", "heartbeat");
      expect(
        json(
          yield* retryUnavailableHttpRequest(
            "heartbeat pause",
            http.request({
              headers: auth,
              method: "POST",
              path: `/v1/heartbeats/${heartbeatId}/pause`,
            }),
          ),
          200,
          "heartbeat pause",
        ).status,
      ).toBe("paused");
      expect(
        json(
          yield* retryUnavailableHttpRequest(
            "heartbeat resume",
            http.request({
              headers: auth,
              method: "POST",
              path: `/v1/heartbeats/${heartbeatId}/resume`,
            }),
          ),
          200,
          "heartbeat resume",
        ).status,
      ).toBe("active");
      const heartbeatFire = json(
        yield* retryUnavailableHttpRequest(
          "heartbeat fire",
          http.request({
            body: { agentDeploymentId: agent.deploymentId, fireKey: `${runKey}:heartbeat-fire` },
            headers: { ...auth, "idempotency-key": `${runKey}:heartbeat-fire` },
            method: "POST",
            path: `/v1/heartbeats/${heartbeatId}/fire`,
          }),
        ),
        202,
        "heartbeat fire",
      );
      expect(heartbeatFire.duplicate).toBe(false);
      const firedHeartbeat = record(heartbeatFire.heartbeatRun, "heartbeat fire.heartbeatRun");
      expect(firedHeartbeat.status).toBe("accepted");
      const heartbeatRun = record(heartbeatFire.run, "heartbeat fire.run");
      const heartbeatRunId = stringField(heartbeatRun, "runId", "heartbeat fire.run");
      const heartbeatThreadId = stringField(heartbeatRun, "threadId", "heartbeat fire.run");
      expect(
        json(
          yield* retryUnavailableHttpRequest(
            "heartbeat pause after fire",
            http.request({
              headers: auth,
              method: "POST",
              path: `/v1/heartbeats/${heartbeatId}/pause`,
            }),
          ),
          200,
          "heartbeat pause after fire",
        ).status,
      ).toBe("paused");

      yield* eventually(
        { label: `scheduled run ${scheduledRunId}`, timeoutMs: 180_000 },
        retryUnavailableHttpRequest(
          "scheduled run read",
          http.request({
            headers: auth,
            method: "GET",
            path: `/v1/threads/${scheduledThreadId}/runs/${scheduledRunId}`,
          }),
        ).pipe(
          Effect.map((response) => {
            const run = json(response, 200, "scheduled run");
            if (run.status === "failed") throw new Error(`Scheduled run failed: ${response.body}`);
            return run.status === "completed" ? run : undefined;
          }),
        ),
      );
      yield* eventually(
        { label: `heartbeat run ${heartbeatRunId}`, timeoutMs: 180_000 },
        retryUnavailableHttpRequest(
          "heartbeat run read",
          http.request({
            headers: auth,
            method: "GET",
            path: `/v1/threads/${heartbeatThreadId}/runs/${heartbeatRunId}`,
          }),
        ).pipe(
          Effect.map((response) => {
            const run = json(response, 200, "heartbeat run");
            if (run.status === "failed") {
              throw new Error(`Heartbeat run failed: ${response.body}`);
            }
            return run.status === "completed" ? run : undefined;
          }),
        ),
      );
      const scheduleHistory = json(
        yield* retryUnavailableHttpRequest(
          "schedule history",
          http.request({
            headers: auth,
            method: "GET",
            path: `/v1/schedules/${scheduleId}/fires`,
          }),
        ),
        200,
        "schedule history",
      );
      expect(scheduleHistory.fires).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ runId: scheduledRunId, status: "accepted" }),
        ]),
      );
      const heartbeatHistory = json(
        yield* retryUnavailableHttpRequest(
          "heartbeat history",
          http.request({
            headers: auth,
            method: "GET",
            path: `/v1/heartbeats/${heartbeatId}/fires`,
          }),
        ),
        200,
        "heartbeat history",
      );
      expect(heartbeatHistory.fires).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ heartbeatId, runId: heartbeatRunId, status: "accepted" }),
        ]),
      );
      const delivery = yield* eventually(
        { label: `webhook delivery ${webhookId}`, timeoutMs: 180_000 },
        retryUnavailableHttpRequest(
          "webhook delivery read",
          http.request({
            headers: auth,
            method: "GET",
            path: `/v1/webhook-deliveries?webhookId=${webhookId}`,
          }),
        ).pipe(
          Effect.map((response) => {
            const page = json(response, 200, "webhook deliveries");
            const deliveries = Array.isArray(page.deliveries) ? page.deliveries : [];
            const found = deliveries
              .map((value, index) => record(value, `delivery[${index}]`))
              .find((value) => value.webhookEndpointId === webhookId);
            if (found?.status === "failed") {
              throw new Error(`Webhook delivery failed: ${JSON.stringify(found)}`);
            }
            return found?.status === "delivered" ? found : undefined;
          }),
        ),
      );
      expect(delivery.responseCode).toBe(200);
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  600_000,
);
