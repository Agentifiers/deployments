import { expect, it } from "@effect/vitest";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { promisify } from "node:util";
import { Effect } from "effect";
import { CliProcess, CliProcessLive } from "../harness/cli-process.ts";
import { eventually } from "../harness/eventually.ts";
import { E2eHttpClient, httpClientLayer } from "../harness/http-client.ts";
import {
  acquireLiveAgent,
  numberField,
  record,
  retryUnavailableHttpRequest,
  stringField,
} from "../harness/live-agent.ts";
import { json, records } from "../harness/response-records.ts";
import { credentialedE2eEnabled, e2eApiUrl, scopedE2eConfig } from "../harness/live-config.ts";
import { tenantHeaders } from "../harness/platform-credential.ts";
import { liveAgentModel } from "../harness/live-model.ts";

const enabled = credentialedE2eEnabled();
const execFileAsync = promisify(execFile);
const publicRedirectLocation = "https://example.com/";
// httpbin.org refuses to redirect to hosts that resolve to reserved addresses, so both redirects
// use Postman Echo, which redirects to any URL.
const publicRedirectUrl = `https://postman-echo.com/redirect-to?url=${encodeURIComponent(publicRedirectLocation)}`;

function publicToReservedRedirect(runKey: string) {
  const hostname = `${runKey}.169-254-169-254.sslip.io`;
  const location = `http://${hostname}/latest/meta-data/`;
  return {
    destinationHash: createHash("sha256").update(hostname).digest("hex"),
    hostname,
    location,
    url: `https://postman-echo.com/redirect-to?url=${encodeURIComponent(location)}`,
  };
}

async function webEgressDenialSeen(startTime: number, destinationHash: string) {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "aws",
      [
        "logs",
        "filter-log-events",
        "--region",
        process.env.AWS_REGION ?? "us-east-2",
        "--log-group-name",
        "/ecs/web-tools",
        "--start-time",
        String(startTime),
        "--filter-pattern",
        `{ $.event = "browser-egress.denied" && $.destinationHash = "${destinationHash}" && $.reason = "non-public-dns" }`,
        "--limit",
        "100",
        "--output",
        "json",
      ],
      { encoding: "utf8", maxBuffer: 5 * 1_024 * 1_024, timeout: 30_000 },
    ));
  } catch (cause) {
    const stderr =
      typeof cause === "object" &&
      cause !== null &&
      "stderr" in cause &&
      typeof cause.stderr === "string"
        ? cause.stderr.trim()
        : "";
    throw new Error(`Unable to read Web Tools egress evidence${stderr ? `: ${stderr}` : "."}`, {
      cause,
    });
  }
  const result = record(JSON.parse(stdout) as unknown, "Web Tools egress log response");
  return records(result.events, "Web Tools egress log response.events").some((event) => {
    const message = stringField(event, "message", "Web Tools egress denial event");
    return (
      message.includes(`"destinationHash":"${destinationHash}"`) &&
      message.includes('"event":"browser-egress.denied"') &&
      message.includes('"reason":"non-public-dns"')
    );
  });
}

function manifest(
  runKey: string,
  requests: readonly {
    readonly input: Readonly<Record<string, unknown>>;
    readonly inputSummary: string;
    readonly toolName: "web.scrape" | "web.search";
  }[],
) {
  return {
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: {
      key: runKey,
      name: `E2E web tools ${runKey}`,
      version: "1.0.0",
    },
    spec: {
      capabilities: {
        tools: [...new Set(requests.map(({ toolName }) => toolName))].map((toolName) => ({
          authorization: "none",
          name: toolName,
          required: false,
          requiredScopes: [],
        })),
      },
      instructions: "Confirm the preconfigured web tool result in one short sentence.",
      model: liveAgentModel.model,
      runtime: {
        ...liveAgentModel.runtime,
        toolRequests: requests.map(({ input, inputSummary, toolName }, index) => ({
          effect: "read",
          idempotencyKey: `${runKey}:tool-call:${index}`,
          input,
          inputSummary,
          requiredScopes: [],
          toolName,
        })),
      },
      sandbox: { mode: "none" },
      triggers: ["api"],
    },
  };
}

it.effect.skipIf(!enabled)(
  "proves hosted web search, public redirects, and public-to-reserved redirect rejection",
  () =>
    Effect.gen(function* () {
      const config = yield* scopedE2eConfig;
      const cli = yield* CliProcess;
      const http = yield* E2eHttpClient;

      const searchKey = `e2e-web-search-${randomUUID()}`;
      const searchAgent = yield* acquireLiveAgent(
        cli,
        config,
        searchKey,
        manifest(searchKey, [
          {
            input: {
              limit: 3,
              query: "Deployments.ai agent platform",
              sources: ["web"],
            },
            inputSummary: "E2E requested web.search.",
            toolName: "web.search",
          },
        ]),
      );
      const searchAuth = tenantHeaders(searchAgent.runtimeApiKey, config);
      const submittedSearch = json(
        yield* retryUnavailableHttpRequest(
          "web search run submit",
          http.request({
            body: {
              content: "Execute the configured hosted web search proof.",
              title: `Web search proof ${searchKey}`,
            },
            headers: { ...searchAuth, "idempotency-key": `${searchKey}:run` },
            method: "POST",
            path: `/v1/agent-deployments/${searchAgent.deploymentId}/runs`,
            timeoutMs: 60_000,
          }),
        ),
        202,
        "web search run submit",
      );
      const searchRunId = stringField(
        record(submittedSearch.run, "web search submitted run"),
        "id",
        "web search submitted run",
      );
      const searchThreadId = stringField(
        record(submittedSearch.thread, "web search submitted thread"),
        "id",
        "web search submitted thread",
      );

      yield* eventually(
        {
          label: `completed web search run ${searchRunId}`,
          timeoutMs: 240_000,
        },
        http
          .request({
            headers: searchAuth,
            method: "GET",
            path: `/v1/threads/${searchThreadId}/runs/${searchRunId}`,
          })
          .pipe(
            Effect.map((response) => {
              const current = json(response, 200, "web search run get");
              if (current.status === "failed") {
                throw new Error(`Hosted web search run failed: ${response.body}`);
              }
              return current.status === "completed" ? current : undefined;
            }),
          ),
      );

      const searchCalls = records(
        json(
          yield* http.request({
            headers: searchAuth,
            method: "GET",
            path: `/v1/runs/${searchRunId}/tool-calls`,
          }),
          200,
          "web search tool calls",
        ).toolCalls,
        "web search tool calls.toolCalls",
      );
      expect(searchCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            outputSummary: expect.stringMatching(
              /^web\.search completed with [1-9][0-9]* result\(s\)\.$/u,
            ),
            policyAction: "allow",
            status: "succeeded",
            toolName: "web.search",
          }),
        ]),
      );

      const searchArtifacts = records(
        json(
          yield* http.request({
            headers: searchAuth,
            method: "GET",
            path: `/v1/artifacts?runId=${searchRunId}`,
          }),
          200,
          "web search artifacts",
        ).artifacts,
        "web search artifacts.artifacts",
      );
      expect(searchArtifacts).toEqual([]);

      const redirectKey = `e2e-web-redirect-${randomUUID()}`;
      const reservedRedirect = publicToReservedRedirect(redirectKey);
      const [publicRedirectResponse, reservedRedirectResponse, reservedAnswers] =
        yield* Effect.tryPromise(() =>
          Promise.all([
            fetch(publicRedirectUrl, {
              redirect: "manual",
              signal: AbortSignal.timeout(30_000),
            }),
            fetch(reservedRedirect.url, {
              redirect: "manual",
              signal: AbortSignal.timeout(30_000),
            }),
            lookup(reservedRedirect.hostname, { all: true, verbatim: true }),
          ]),
        );
      expect(publicRedirectResponse.status).toBe(302);
      expect(publicRedirectResponse.headers.get("location")).toBe(publicRedirectLocation);
      expect(reservedRedirectResponse.status).toBe(302);
      expect(reservedRedirectResponse.headers.get("location")).toBe(reservedRedirect.location);
      expect(reservedAnswers).toEqual(
        expect.arrayContaining([{ address: "169.254.169.254", family: 4 }]),
      );

      const redirectAgent = yield* acquireLiveAgent(
        cli,
        config,
        redirectKey,
        manifest(redirectKey, [
          {
            input: { onlyMainContent: true, url: publicRedirectUrl },
            inputSummary: "E2E requested public-to-public redirect web.scrape.",
            toolName: "web.scrape",
          },
          {
            input: { url: reservedRedirect.url },
            inputSummary: "E2E requested public-to-reserved redirect web.scrape.",
            toolName: "web.scrape",
          },
        ]),
      );
      const redirectAuth = tenantHeaders(redirectAgent.runtimeApiKey, config);
      const denialEvidenceStartedAt = Date.now() - 1_000;
      const submittedRedirect = json(
        yield* retryUnavailableHttpRequest(
          "public-to-reserved redirect run submit",
          http.request({
            body: {
              content: "Execute the configured public-to-reserved redirect rejection proof.",
              title: `Public-to-reserved redirect proof ${redirectKey}`,
            },
            headers: {
              ...redirectAuth,
              "idempotency-key": `${redirectKey}:run`,
            },
            method: "POST",
            path: `/v1/agent-deployments/${redirectAgent.deploymentId}/runs`,
            timeoutMs: 60_000,
          }),
        ),
        202,
        "public-to-reserved redirect run submit",
      );
      const redirectRunId = stringField(
        record(submittedRedirect.run, "public-to-reserved redirect submitted run"),
        "id",
        "public-to-reserved redirect submitted run",
      );

      const redirectCalls = yield* eventually(
        {
          label: `successful public redirect before reserved denial ${redirectRunId}`,
          timeoutMs: 180_000,
        },
        http
          .request({
            headers: redirectAuth,
            method: "GET",
            path: `/v1/runs/${redirectRunId}/tool-calls`,
          })
          .pipe(
            Effect.map((response) => {
              const calls = records(
                json(response, 200, "public-to-reserved redirect tool calls").toolCalls,
                "public-to-reserved redirect tool calls.toolCalls",
              );
              if (
                calls.some(
                  (call) =>
                    call.inputSummary === "E2E requested public-to-reserved redirect web.scrape." &&
                    call.status === "succeeded",
                )
              ) {
                throw new Error("Public-to-reserved redirect web scrape unexpectedly completed.");
              }
              return calls.some(
                (call) =>
                  call.inputSummary === "E2E requested public-to-public redirect web.scrape." &&
                  call.status === "succeeded",
              )
                ? calls
                : undefined;
            }),
          ),
      );
      expect(redirectCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            inputSummary: "E2E requested public-to-public redirect web.scrape.",
            policyAction: "allow",
            status: "succeeded",
            toolName: "web.scrape",
          }),
        ]),
      );

      const redirectThreadId = stringField(
        record(submittedRedirect.thread, "public-to-reserved redirect submitted thread"),
        "id",
        "public-to-reserved redirect submitted thread",
      );

      yield* eventually(
        {
          intervalMs: 2_000,
          label: `Web Tools egress denial ${reservedRedirect.destinationHash}`,
          timeoutMs: 60_000,
        },
        Effect.tryPromise(() =>
          webEgressDenialSeen(denialEvidenceStartedAt, reservedRedirect.destinationHash),
        ).pipe(Effect.map((seen) => (seen ? true : undefined))),
      );

      const retriedRedirectRun = yield* eventually(
        {
          label: `retried public-to-reserved redirect run ${redirectRunId}`,
          timeoutMs: 120_000,
        },
        http
          .request({
            headers: redirectAuth,
            method: "GET",
            path: `/v1/threads/${redirectThreadId}/runs/${redirectRunId}`,
          })
          .pipe(
            Effect.map((response) => {
              const current = json(response, 200, "public-to-reserved redirect run get");
              if (current.status === "completed") {
                throw new Error("Public-to-reserved redirect web scrape unexpectedly completed.");
              }
              return numberField(current, "attempt", "public-to-reserved redirect run") >= 2
                ? current
                : undefined;
            }),
          ),
      );
      expect(retriedRedirectRun.status).not.toBe("completed");

      // The exact proxy denial, a completed public redirect, and a subsequent
      // nonterminal retry are the proof. Cancellation only stops further
      // read-tool retries after those assertions have already passed.
      const stoppedRedirectRun = yield* eventually(
        {
          label: `stop public-to-reserved redirect run ${redirectRunId}`,
          timeoutMs: 30_000,
        },
        Effect.gen(function* () {
          const cancellation = yield* http.request({
            headers: redirectAuth,
            method: "POST",
            path: `/v1/runs/${redirectRunId}/cancel`,
          });
          if (cancellation.status === 200) {
            return record(cancellation.json, "public-to-reserved redirect run cancel");
          }
          expect(cancellation.status, cancellation.body).toBe(409);
          const current = json(
            yield* http.request({
              headers: redirectAuth,
              method: "GET",
              path: `/v1/threads/${redirectThreadId}/runs/${redirectRunId}`,
            }),
            200,
            "raced public-to-reserved redirect run get",
          );
          if (current.status === "completed") {
            throw new Error("Public-to-reserved redirect web scrape unexpectedly completed.");
          }
          return current.status === "canceled" || current.status === "failed" ? current : undefined;
        }),
      );
      expect(["canceled", "failed"]).toContain(stoppedRedirectRun.status);

      const finalRedirectCalls = records(
        json(
          yield* http.request({
            headers: redirectAuth,
            method: "GET",
            path: `/v1/runs/${redirectRunId}/tool-calls`,
          }),
          200,
          "final public-to-reserved redirect tool calls",
        ).toolCalls,
        "final public-to-reserved redirect tool calls.toolCalls",
      );
      expect(finalRedirectCalls).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            inputSummary: "E2E requested public-to-reserved redirect web.scrape.",
            status: "succeeded",
          }),
        ]),
      );
      expect(finalRedirectCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            inputSummary: "E2E requested public-to-public redirect web.scrape.",
            policyAction: "allow",
            status: "succeeded",
            toolName: "web.scrape",
          }),
        ]),
      );

      const redirectArtifacts = records(
        json(
          yield* http.request({
            headers: redirectAuth,
            method: "GET",
            path: `/v1/artifacts?runId=${redirectRunId}`,
          }),
          200,
          "public-to-reserved redirect artifacts",
        ).artifacts,
        "public-to-reserved redirect artifacts.artifacts",
      );
      expect(redirectArtifacts).toEqual([]);
    }).pipe(Effect.provide(CliProcessLive), Effect.provide(httpClientLayer(e2eApiUrl()))),
  900_000,
);
