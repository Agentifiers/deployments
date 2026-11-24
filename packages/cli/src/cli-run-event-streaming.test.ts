import { MOCK_RUNTIME_FIXTURE_IDS } from "@agentifiers/deployments-sdk";
import { afterEach, describe, expect, it } from "bun:test";
import { runCli } from "./cli.ts";
import { harness, removeTemporaryDirectories } from "./cli-test-harness.ts";

afterEach(removeTemporaryDirectories);

/** A Durable Streams SSE response that delivers `events` and then ends the connection. */
function eventStream(...events: string[]) {
  return new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });
}

describe("CLI configuration and output", () => {
  it("streams run events as redacted NDJSON", async () => {
    const test = await harness();
    expect(
      await runCli(
        [
          "run",
          "tail",
          MOCK_RUNTIME_FIXTURE_IDS.run,
          "--thread",
          MOCK_RUNTIME_FIXTURE_IDS.thread,
          "--json",
          "--no-color",
        ],
        test,
      ),
    ).toBe(0);
    expect(test.stdout).toHaveLength(3);
    expect(test.stdout.map((line) => JSON.parse(line).eventType)).toEqual([
      "run.started",
      "assistant-message.finalized",
      "run.completed",
    ]);
  });

  it("creates a live stream session before tailing with its scoped bearer token", async () => {
    const requests: Array<{
      authorization: string | null;
      host: string | null;
      path: string;
      search: string;
    }> = [];
    let streamReads = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url);
        requests.push({
          authorization: request.headers.get("authorization"),
          host: request.headers.get("host"),
          path: url.pathname,
          search: url.search,
        });
        if (url.pathname.endsWith("/runs/run_1")) {
          return Response.json({ id: "run_1", status: "running" });
        }
        if (url.pathname.endsWith("/stream-sessions")) {
          return Response.json({
            accessToken: "thread-session-token",
            history: [],
            session: { offset: "9" },
            streamUrl: `http://127.0.0.1:${server.port}/v1/threads/thread_1/stream`,
          });
        }
        streamReads += 1;
        return streamReads === 1
          ? eventStream(
              'event: data\ndata: [{"eventType":"run.started","runId":"run_1"}]\n\n',
              'event: control\ndata: {"streamCursor":"cursor_2","streamNextOffset":"18","upToDate":true}\n\n',
            )
          : eventStream(
              'event: data\ndata: [{"eventType":"run.completed","runId":"run_1"}]\n\n',
              'event: control\ndata: {"streamCursor":"cursor_3","streamNextOffset":"27","streamClosed":true}\n\n',
            );
      },
    });
    try {
      const test = await harness();
      expect(
        await runCli(
          [
            "run",
            "tail",
            "run_1",
            "--thread",
            "thread_1",
            "--cursor",
            "cursor_1",
            "--follow",
            "--live",
            "--api-url",
            server.url.toString(),
            "--api-key",
            "platform-api-key",
            "--env",
            "env_1",
            "--json",
            "--no-color",
          ],
          test,
        ),
      ).toBe(0);
      const gatewayHost = `127.0.0.1:${server.port}`;
      expect(requests).toEqual([
        {
          authorization: "Bearer platform-api-key",
          host: `localhost:${server.port}`,
          path: "/v1/threads/thread_1/runs/run_1",
          search: "",
        },
        {
          authorization: "Bearer platform-api-key",
          host: `localhost:${server.port}`,
          path: "/v1/threads/thread_1/stream-sessions",
          search: "",
        },
        {
          authorization: "Bearer thread-session-token",
          host: gatewayHost,
          path: "/v1/threads/thread_1/stream",
          search: "?cursor=cursor_1&live=sse&offset=-1",
        },
        {
          authorization: "Bearer thread-session-token",
          host: gatewayHost,
          path: "/v1/threads/thread_1/stream",
          search: "?cursor=cursor_2&live=sse&offset=18",
        },
      ]);
      expect(test.stdout.map((line) => JSON.parse(line).eventType)).toEqual([
        "run.started",
        "run.completed",
      ]);
    } finally {
      await server.stop(true);
    }
  });

  it("drains bounded stream pages before returning without follow", async () => {
    let streamReads = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/runs/run_1")) {
          return Response.json({ id: "run_1", status: "running" });
        }
        if (url.pathname.endsWith("/stream-sessions")) {
          return Response.json({
            accessToken: "thread-session-token",
            history: [],
            session: { offset: "0" },
            streamUrl: `${server.url.href}v1/threads/thread_1/stream`,
          });
        }
        streamReads += 1;
        return streamReads === 1
          ? Response.json([{ eventType: "run.started", runId: "run_1" }], {
              headers: {
                "stream-next-offset": "18",
                "stream-up-to-date": "false",
              },
            })
          : Response.json([{ eventType: "run.completed", runId: "run_1" }], {
              headers: {
                "stream-next-offset": "27",
                "stream-up-to-date": "true",
              },
            });
      },
    });
    try {
      const test = await harness();
      expect(
        await runCli(
          [
            "run",
            "tail",
            "run_1",
            "--thread",
            "thread_1",
            "--live",
            "--api-url",
            server.url.toString(),
            "--api-key",
            "platform-api-key",
            "--env",
            "env_1",
            "--json",
            "--no-color",
          ],
          test,
        ),
      ).toBe(0);
      expect(streamReads).toBe(2);
      expect(test.stdout.map((line) => JSON.parse(line).eventType)).toEqual([
        "run.started",
        "run.completed",
      ]);
    } finally {
      await server.stop(true);
    }
  });

  it("renews an expired stream session while following", async () => {
    let sessions = 0;
    const streamAuthorizations: Array<string | null> = [];
    const server = Bun.serve({
      port: 0,
      fetch(request): Response {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/runs/run_1")) {
          return Response.json({ id: "run_1", status: "running" });
        }
        if (url.pathname.endsWith("/stream-sessions")) {
          sessions += 1;
          return Response.json({
            accessToken: `thread-session-token-${sessions}`,
            history: [],
            session: { offset: "0" },
            streamUrl: `${server.url.href}v1/threads/thread_1/stream`,
          });
        }
        streamAuthorizations.push(request.headers.get("authorization"));
        if (sessions === 1) {
          return Response.json(
            { status: 401, title: "Thread stream session expired" },
            { status: 401 },
          );
        }
        return eventStream(
          'event: data\ndata: [{"eventType":"run.completed","runId":"run_1"}]\n\n',
          'event: control\ndata: {"streamNextOffset":"18","streamClosed":true}\n\n',
        );
      },
    });
    try {
      const test = await harness();
      expect(
        await runCli(
          [
            "run",
            "tail",
            "run_1",
            "--thread",
            "thread_1",
            "--follow",
            "--live",
            "--api-url",
            server.url.toString(),
            "--api-key",
            "platform-api-key",
            "--env",
            "env_1",
            "--json",
            "--no-color",
          ],
          test,
        ),
      ).toBe(0);
      expect(sessions).toBe(2);
      expect(streamAuthorizations).toEqual([
        "Bearer thread-session-token-1",
        "Bearer thread-session-token-2",
      ]);
      expect(test.stdout.map((line) => JSON.parse(line).eventType)).toEqual(["run.completed"]);
    } finally {
      await server.stop(true);
    }
  });
});
