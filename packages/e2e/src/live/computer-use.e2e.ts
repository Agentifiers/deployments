import { expect, it } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import { E2eHttpClient, httpClientLayer } from "../harness/http-client.ts";
import {
  acquireLiveAgent,
  record,
  retryUnavailableHttpRequest,
  stringField,
} from "../harness/live-agent.ts";
import { json, records } from "../harness/response-records.ts";
import { credentialedE2eEnabled, e2eApiUrl, scopedE2eConfig } from "../harness/live-config.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";
import { liveAgentModel } from "../harness/live-model.ts";

// Needs a deployment whose target sets "lambdaMicrovmImage": "desktop" and an image-capable model.
const enabled = credentialedE2eEnabled() && process.env.DEPLOYMENTS_E2E_DESKTOP === "true";
const pageUrl = "https://example.com/";
const xtermMarker = "desktop-kept-across-checkpoint";

/** The window count each computer call reported, in execution order (tool call ids are ULIDs). */
function windowCounts(calls: readonly Readonly<Record<string, unknown>>[]) {
  return calls
    .filter((call) => String(call.toolName).startsWith("computer."))
    .toSorted((left, right) => String(left.id).localeCompare(String(right.id)))
    .map((call) => {
      const match = /(\d+) open windows?\.$/u.exec(String(call.outputSummary));
      if (!match)
        throw new Error(`Unexpected computer tool summary: ${String(call.outputSummary)}`);
      return Number(match[1]);
    });
}
it.effect.skipIf(!enabled)(
  "drives Firefox on the sandbox desktop with the computer tools and the computer-use skill",
  () =>
    Effect.gen(function* () {
      const config = yield* scopedE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;
      const runKey = `e2e-computer-use-${randomUUID()}`;
      const manifest = {
        apiVersion: "agents.deployments.ai/v1",
        kind: "Agent",
        metadata: { key: runKey, name: `E2E computer use ${runKey}`, version: "1.0.0" },
        spec: {
          capabilities: {
            tools: ["computer.screenshot", "computer.action"].map((name) => ({
              authorization: "none",
              name,
              required: true,
              requiredScopes: [],
            })),
          },
          instructions:
            "You operate a Linux desktop. Use only the computer tools to do what the user asks, then answer in one short sentence.",
          model: liveAgentModel.model,
          platformSkills: ["computer-use"],
          runtime: {
            ...liveAgentModel.runtime,
            maxModelGenerations: 32,
            maxToolCalls: 48,
            modelTools: ["computer.screenshot", "computer.action"],
            toolResultImages: "screenshots",
          },
          sandbox: { mode: "thread-persistent", provider: "aws_lambda_microvm" },
          triggers: ["api"],
        },
      };
      const agent = yield* acquireLiveAgent(cli, config, runKey, manifest);
      const auth = tenantHeaders(agent.runtimeApiKey, config);
      const submitted = json(
        yield* retryUnavailableHttpRequest(
          "computer use run submit",
          http.request({
            body: {
              content: [
                `Open Firefox at ${pageUrl} and read the page's main heading.`,
                `Then open xterm, run \`echo ${xtermMarker}\`, and read the output.`,
                "Then click the Firefox window, scroll the page down and back up, and check the heading again.",
                "Reply with the heading exactly as shown and the xterm output.",
              ].join(" "),
              title: `Computer use proof ${runKey}`,
            },
            headers: { ...auth, "idempotency-key": `${runKey}:run` },
            method: "POST",
            path: `/v1/agent-deployments/${agent.deploymentId}/runs`,
            timeoutMs: 60_000,
          }),
        ),
        202,
        "computer use run submit",
      );
      const runId = stringField(record(submitted.run, "submitted.run"), "id", "submitted.run");
      const threadId = stringField(
        record(submitted.thread, "submitted.thread"),
        "id",
        "submitted.thread",
      );

      const run = yield* eventually(
        { label: `finished computer use run ${runId}`, timeoutMs: 600_000 },
        http
          .request({ headers: auth, method: "GET", path: `/v1/threads/${threadId}/runs/${runId}` })
          .pipe(
            Effect.map((response) => {
              const current = json(response, 200, "computer use run get");
              return current.status === "completed" || current.status === "failed"
                ? current
                : undefined;
            }),
          ),
      );

      const calls = records(
        json(
          yield* http.request({
            headers: auth,
            method: "GET",
            path: `/v1/runs/${runId}/tool-calls`,
          }),
          200,
          "computer use tool calls",
        ).toolCalls,
        "computer use tool calls.toolCalls",
      );
      expect(run, `computer use run ${runId}`).toMatchObject({ status: "completed" });
      // The task takes more tool calls than one execution slice saves, so the run checkpoints and
      // resumes at least once; the desktop must keep its windows through every resume.
      expect(Number(run.checkpointCount)).toBeGreaterThan(0);
      expect(calls.every((call) => call.status === "succeeded")).toBe(true);
      const counts = windowCounts(calls);
      const firstWindow = counts.findIndex((count) => count > 0);
      expect(firstWindow).toBeGreaterThanOrEqual(0);
      expect(counts.slice(firstWindow), `window counts ${counts.join(",")}`).not.toContain(0);

      const messages = records(
        json(
          yield* http.request({
            headers: auth,
            method: "GET",
            path: `/v1/threads/${threadId}/messages`,
          }),
          200,
          "computer use thread messages",
        ).messages,
        "computer use thread messages.messages",
      );
      const answer = messages.findLast((message) => message.role === "assistant");
      expect(String(answer?.body)).toContain("Example Domain");
      expect(String(answer?.body)).toContain(xtermMarker);
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  900_000,
);
