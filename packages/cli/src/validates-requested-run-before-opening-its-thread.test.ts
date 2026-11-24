import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import type { CliIo } from "./types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "deployments-cli-"));
  temporaryDirectories.push(directory);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    isInteractive: false,
  };
  return {
    directory,
    env: { DEPLOYMENTS_CONFIG_DIR: directory, DEPLOYMENTS_MOCK: "1", NO_COLOR: "1" },
    io,
    stdout,
    stderr,
  };
}

describe("CLI configuration and output", () => {
  it("validates the requested run before opening its thread stream", async () => {
    let streamSessions = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/runs/run_missing")) {
          return Response.json({ status: 404, title: "Run not found" }, { status: 404 });
        }
        if (url.pathname.endsWith("/stream-sessions")) streamSessions += 1;
        return Response.json({});
      },
    });
    try {
      const test = await harness();
      expect(
        await runCli(
          [
            "run",
            "tail",
            "run_missing",
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
      ).toBe(5);
      expect(streamSessions).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  it("closes a followed mock stream when no event matches the requested run", async () => {
    const test = await harness();
    expect(
      await runCli(
        ["run", "tail", "run_missing", "--thread", "thread_1", "--follow", "--mock", "--json"],
        test,
      ),
    ).toBe(0);
    expect(test.stdout).toEqual([]);
  });

  it("honors an explicit chat idempotency key", async () => {
    let idempotencyKey: string | null = null;
    let requestPath: string | null = null;
    let requestBody: unknown;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        idempotencyKey = request.headers.get("idempotency-key");
        requestPath = new URL(request.url).pathname;
        requestBody = await request.json();
        return Response.json({ id: "run_1", status: "queued" });
      },
    });
    try {
      const test = await harness();
      expect(
        await runCli(
          [
            "chat",
            "--message",
            "hello",
            "--agent",
            "deployment_1",
            "--live",
            "--api-url",
            server.url.toString(),
            "--env",
            "env_1",
            "--idempotency-key",
            "idem_chat_1",
            "--json",
          ],
          test,
        ),
      ).toBe(0);
      expect(idempotencyKey === "idem_chat_1").toBe(true);
      expect(requestPath === "/v1/agent-deployments/deployment_1/runs").toBe(true);
      expect(requestBody).toEqual({ content: "hello" });
    } finally {
      await server.stop(true);
    }
  });

  it("accepts dash-prefixed string option values", async () => {
    const test = await harness();
    expect(
      await runCli(
        [
          "chat",
          "--message",
          "- restart the worker",
          "--agent",
          "deployment_1",
          "--json",
          "--no-color",
        ],
        test,
      ),
    ).toBe(0);
    expect(JSON.parse(test.stdout[0]!).message.body).toBe("- restart the worker");

    test.stdout.length = 0;
    expect(
      await runCli(
        ["chat", "--message=--help", "--agent", "deployment_1", "--json", "--no-color"],
        test,
      ),
    ).toBe(0);
    expect(JSON.parse(test.stdout[0]!).message.body).toBe("--help");

    const idempotency = await harness();
    expect(
      await runCli(
        [
          "chat",
          "--message",
          "hello",
          "--agent",
          "deployment_1",
          "--idempotency-key",
          "",
          "--json",
        ],
        idempotency,
      ),
    ).toBe(7);
    expect(idempotency.stderr.join("\n")).toContain("--idempotency-key must not be empty");
  });

  it("sanitizes API failures, honors HTTP status, and disables failure color", async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(
          JSON.stringify({
            title: "Stale auth status",
            detail: "unsafe dpl_reflected_secret\u001b]52;c;Y2xpcGJvYXJk\u0007\u202espoof",
            status: 401,
            requestId: "req\u001b[31m_bad",
          }),
          { status: 500, headers: { "content-type": "application/problem+json" } },
        );
      },
    });
    try {
      const test = await harness();
      expect(
        await runCli(["health", "--live", "--api-url", server.url.toString(), "--no-color"], test),
      ).toBe(8);
      expect(test.stderr.join("\n")).toContain("Error: Stale auth status");
      expect(test.stderr.join("\n")).not.toContain("dpl_reflected_secret");
      expect(test.stderr.join("\n")).not.toContain("\u001b");
      expect(test.stderr.join("\n")).not.toContain("\u202e");
    } finally {
      await server.stop(true);
    }
  });

  it("includes custom top-level commands in the machine-readable catalog", async () => {
    const test = await harness();
    expect(await runCli(["catalog", "--json", "--no-color"], test)).toBe(0);
    const commands = JSON.parse(test.stdout[0]!).map((entry: { command: string }) => entry.command);
    expect(commands).toEqual(
      expect.arrayContaining([
        "deployments auth login",
        "deployments context set",
        "deployments whoami",
        "deployments chat",
        "deployments health",
        "deployments openapi",
        "deployments catalog",
      ]),
    );
    expect(commands).not.toContain("deployments metadata");
  });

  it("uses the canonical health and OpenAPI discovery routes", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        paths.push(new URL(request.url).pathname);
        return Response.json({ status: "ok" });
      },
    });
    try {
      const test = await harness();
      const transport = ["--live", "--api-url", server.url.toString(), "--json"];

      expect(await runCli(["health", ...transport], test)).toBe(0);
      expect(await runCli(["openapi", ...transport], test)).toBe(0);
      expect(paths).toEqual(["/health", "/v1/openapi.json"]);
    } finally {
      await server.stop(true);
    }
  });

  it("maps live transport failures to service unavailable", async () => {
    const test = await harness();
    expect(
      await runCli(["health", "--live", "--api-url", "http://127.0.0.1:1", "--json"], test),
    ).toBe(8);
  });

  it("renders nested help with the public executable name", async () => {
    const test = await harness();
    expect(await runCli(["project", "create", "--help", "--no-color"], test)).toBe(0);
    expect(test.stdout.join("\n")).toContain("USAGE deployments project create");
    expect(test.stdout.join("\n")).not.toContain("src/bin.ts");
  });

  it("rejects inherited object properties as command names", async () => {
    for (const command of [["constructor"], ["project", "toString"], ["constructor", "--help"]]) {
      const test = await harness();
      expect(await runCli([...command, "--no-color"], test)).toBe(2);
      expect(test.stderr.join("\n")).toContain("Unknown command");
    }
  });
});
