import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../cli.ts";
import { ExitCode } from "../errors.ts";
import type { CliIo } from "../types.ts";

const temporaryDirectories: string[] = [];
const stopServers: (() => void)[] = [];

afterEach(async () => {
  for (const stop of stopServers.splice(0)) stop();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const manifest = {
  apiVersion: "agents.deployments.ai/v1",
  kind: "Agent",
  metadata: { key: "example.assistant", name: "Example Assistant", version: "1.0.0" },
  spec: {
    capabilities: { tools: [] },
    instructions: "Answer briefly.",
    memory: { mode: "off" },
    model: { id: "openrouter/default" },
    sandbox: { mode: "none" },
    triggers: ["api"],
  },
};

interface Scenario {
  readonly events: readonly Record<string, unknown>[];
  readonly runStatus: string;
  readonly runError?: Record<string, unknown>;
  readonly messageBody?: string;
}

/** Serves the preview, run, and thread stream routes one preview turn uses. */
function fakeApi(scenario: Scenario) {
  const requests: string[] = [];
  const run = { id: "run_1", threadId: "thread_1" };
  const server = Bun.serve({
    port: 0,
    fetch(request): Response {
      const url = new URL(request.url);
      requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/v1/previews" && request.method === "POST") {
        return Response.json(
          {
            agentName: "Example Assistant",
            expiresAt: "2026-09-30T00:00:00.000Z",
            id: "preview_1",
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/v1/previews/preview_1" && request.method === "DELETE") {
        return Response.json({ id: "preview_1", status: "expired" });
      }
      if (url.pathname === "/v1/previews/preview_1/turns") {
        return Response.json({ created: true, run, thread: { id: "thread_1" } }, { status: 202 });
      }
      if (url.pathname.endsWith("/stream-sessions")) {
        return Response.json(
          {
            accessToken: "stream-token",
            streamUrl: `${server.url.href}v1/threads/thread_1/stream`,
          },
          { status: 201 },
        );
      }
      if (url.pathname === "/v1/threads/thread_1/stream") {
        const first = url.searchParams.get("offset") === "-1";
        const data = first ? `event: data\ndata: ${JSON.stringify(scenario.events)}\n\n` : "";
        return new Response(
          `${data}event: control\ndata: {"streamNextOffset":"1","upToDate":true}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (url.pathname === "/v1/threads/thread_1/runs/run_1") {
        return Response.json({
          ...run,
          status: scenario.runStatus,
          ...(scenario.runError ? { error: scenario.runError } : {}),
        });
      }
      if (url.pathname === "/v1/threads/thread_1/runs/run_1/message") {
        return Response.json({ body: scenario.messageBody, id: "message_2" });
      }
      return Response.json({ status: 404, title: "Not found" }, { status: 404 });
    },
  });
  stopServers.push(() => server.stop(true));
  return { requests, url: server.url.toString() };
}

async function oneShot(apiUrl: string) {
  const directory = await mkdtemp(join(tmpdir(), "deployments-dev-"));
  temporaryDirectories.push(directory);
  const manifestPath = join(directory, "agent.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    isInteractive: false,
  };
  const exitCode = await runCli(
    [
      "dev",
      manifestPath,
      "--message",
      "hello",
      "--api-url",
      apiUrl,
      "--api-key",
      "platform-api-key",
      "--env",
      "env_1",
      "--no-color",
    ],
    { io, env: { DEPLOYMENTS_CONFIG_DIR: directory, NO_COLOR: "1" } },
  );
  return { exitCode, stderr, stdout };
}

function event(eventType: string, fields: Record<string, unknown> = {}) {
  return { eventId: `${eventType}-event`, eventType, runId: "run_1", ...fields };
}

describe("deployments dev one-shot mode", () => {
  it("streams assistant text and tool calls, then expires the preview", async () => {
    const chunk = (eventId: string, modelCallId: string, sequence: number, text: string) =>
      event("assistant-token.chunk", {
        eventId,
        messageId: "message_2",
        payload: { modelCallId, sequence, text },
      });
    const api = fakeApi({
      events: [
        chunk("chunk-1", "call_1", 0, "Let me che"),
        event("tool.running", {
          payload: { metadata: { inputSummary: "Look up records", toolName: "records.read" } },
          toolCallId: "tool_1",
        }),
        chunk("chunk-2", "call_2", 0, "Draft"),
        chunk("chunk-3", "call_3", 0, "Hello\nwor"),
        chunk("chunk-4", "call_3", 1, "ld"),
        event("assistant-message.finalized", { messageId: "message_2" }),
        event("run.completed"),
      ],
      runStatus: "completed",
    });

    const result = await oneShot(api.url);

    expect(result.exitCode).toBe(ExitCode.success);
    const lookup = result.stdout.indexOf("  records.read running - Look up records");
    expect(result.stdout.slice(lookup - 1, lookup + 4)).toEqual([
      "Let me che",
      "  records.read running - Look up records",
      "Draft",
      "Hello",
      "world",
    ]);
    expect(api.requests).not.toContain("GET /v1/threads/thread_1/runs/run_1/message");
    expect(api.requests.at(-1)).toBe("DELETE /v1/previews/preview_1");
  });

  it("prints the stored reply when no tokens were streamed", async () => {
    const api = fakeApi({
      events: [event("run.completed")],
      messageBody: "Stored answer",
      runStatus: "completed",
    });

    const result = await oneShot(api.url);

    expect(result.exitCode).toBe(ExitCode.success);
    expect(result.stdout).toContain("Stored answer");
  });

  it("exits non-zero with the run error when the run fails", async () => {
    const api = fakeApi({
      events: [event("run.failed")],
      runError: { message: "model unavailable" },
      runStatus: "failed",
    });

    const result = await oneShot(api.url);

    expect(result.exitCode).toBe(ExitCode.unexpected);
    expect(result.stderr.join("\n")).toContain("Run run_1 failed: model unavailable");
    expect(api.requests.at(-1)).toBe("DELETE /v1/previews/preview_1");
  });

  it("refuses to wait for an approval without a terminal and still expires the preview", async () => {
    const api = fakeApi({
      events: [event("approval.requested", { approvalId: "approval_1", toolCallId: "tool_1" })],
      runStatus: "waiting-for-approval",
    });

    const result = await oneShot(api.url);

    expect(result.exitCode).toBe(ExitCode.usage);
    expect(result.stderr.join("\n")).toContain("waiting for approval");
    expect(api.requests.some((request) => request.includes("/approvals/"))).toBe(false);
    expect(api.requests.at(-1)).toBe("DELETE /v1/previews/preview_1");
  });
});
