import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import type { CliIo } from "./types.ts";
const temporaryDirectories: string[] = [];
const temporaryServers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  await Promise.all(temporaryServers.splice(0).map((server) => server.stop(true)));
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
    env: { DEPLOYMENTS_CONFIG_DIR: directory, NO_COLOR: "1" },
    io,
    stdout,
    stderr,
  };
}

describe("CLI capability catalog", () => {
  it("maps memory lifecycle, policy, review, feedback, and flush arguments", async () => {
    const observed: Array<{
      body: unknown;
      method: string;
      path: string;
      query?: Record<string, string>;
    }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        observed.push({
          body: request.body ? await request.json() : undefined,
          method: request.method,
          path: url.pathname,
          ...(url.search ? { query: Object.fromEntries(url.searchParams) } : {}),
        });
        return Response.json({ id: "memory_resource_1", status: "ready" });
      },
    });
    temporaryServers.push(server);
    const test = await harness();
    const transport = ["--live", "--api-url", server.url.toString(), "--env", "env_1", "--json"];

    expect(
      await runCli(
        [
          "memory-space-grant",
          "list",
          "--agent-definition-id",
          "agent_1",
          "--memory-space-id",
          "space_1",
          "--status",
          "all",
          "--page-size",
          "20",
          ...transport,
        ],
        test,
      ),
    ).toBe(0);
    expect(
      await runCli(
        [
          "memory",
          "list",
          "--space",
          "space_1",
          "--status",
          "archived",
          "--page-size",
          "20",
          ...transport,
        ],
        test,
      ),
    ).toBe(0);
    expect(
      await runCli(
        [
          "memory",
          "active-recall",
          "--query",
          "deployment guidance",
          "--run-id",
          "run_1",
          "--top-k",
          "10",
          ...transport,
        ],
        test,
      ),
    ).toBe(0);
    expect(
      await runCli(
        [
          "memory",
          "strategy-search",
          "--query",
          "deployment guidance",
          "--space",
          "space_1",
          "--strategy",
          "hybrid-rerank-v1",
          "--search-keys",
          "deployment,operations",
          "--top-k",
          "15",
          ...transport,
        ],
        test,
      ),
    ).toBe(0);
    expect(await runCli(["memory", "flush-status", "--run-id", "run_1", ...transport], test)).toBe(
      0,
    );

    expect(
      await runCli(
        [
          "memory-space",
          "create",
          "--name",
          "Workspace memory",
          "--kind",
          "workspace",
          "--workspace-id",
          "workspace_1",
          "--retention-days",
          "30",
          ...transport,
        ],
        test,
      ),
    ).toBe(0);
    expect(
      await runCli(
        [
          "memory",
          "flush",
          "--run-id",
          "run_1",
          "--memory-space-id",
          "space_1",
          "--memory-mode",
          "workspace",
          ...transport,
        ],
        test,
      ),
    ).toBe(0);
    expect(
      await runCli(
        [
          "memory-space-grant",
          "create",
          "--agent-definition-id",
          "agent_1",
          "--memory-space-id",
          "space_1",
          "--permission",
          "read-write",
          ...transport,
        ],
        test,
      ),
    ).toBe(0);
    expect(
      await runCli(
        ["memory-space-grant", "update", "grant_1", "--permission", "read", ...transport],
        test,
      ),
    ).toBe(0);
    expect(
      await runCli(["memory-space-grant", "revoke", "grant_1", "--yes", ...transport], test),
    ).toBe(0);
    expect(
      await runCli(
        [
          "memory-policy",
          "create",
          "--scope",
          "environment",
          "--sensitivity-mode",
          "standard",
          ...transport,
        ],
        test,
      ),
    ).toBe(0);
    expect(
      await runCli(
        [
          "memory-policy",
          "upsert",
          "--active-recall-enabled",
          "--active-recall-rollout-percent",
          "25",
          "--scope",
          "workspace",
          "--sensitivity-mode",
          "strict",
          "--retention-days",
          "90",
          "--workspace-id",
          "workspace_1",
          "--processing-config",
          '{"extractor":"standard"}',
          ...transport,
        ],
        test,
      ),
    ).toBe(0);
    expect(
      await runCli(["memory-policy", "upsert", "--disable-active-recall", ...transport], test),
    ).toBe(0);
    expect(
      await runCli(
        [
          "memory-review",
          "resolve",
          "--memory",
          "memory_1",
          "--review",
          "review_1",
          "--decision",
          "edit",
          "--content",
          "Updated memory",
          "--reason",
          "Corrected after operator review",
          "--yes",
          ...transport,
        ],
        test,
      ),
    ).toBe(0);
    expect(
      await runCli(
        [
          "memory-retrieval",
          "feedback",
          "--memory",
          "memory_1",
          "--retrieval",
          "retrieval_1",
          "--usefulness",
          "useful",
          "--feedback",
          "Relevant",
          ...transport,
        ],
        test,
      ),
    ).toBe(0);
    const deletionErrorStart = test.stderr.length;
    expect(await runCli(["memory", "delete", "memory_1", ...transport], test)).toBe(2);
    expect(test.stderr.slice(deletionErrorStart).join("\n")).toContain("require --yes");
    expect(await runCli(["memory", "archive", "memory_1", "--yes", ...transport], test)).toBe(0);
    expect(
      await runCli(
        [
          "memory",
          "search",
          "--query",
          "deployment",
          "--space",
          "space_1",
          "--top-k",
          "25",
          ...transport,
        ],
        test,
      ),
    ).toBe(0);

    expect(observed).toEqual([
      {
        body: undefined,
        method: "GET",
        path: "/v1/memory-space-grants",
        query: {
          agentDefinitionId: "agent_1",
          limit: "20",
          memorySpaceId: "space_1",
          status: "all",
        },
      },
      {
        body: undefined,
        method: "GET",
        path: "/v1/memory",
        query: { limit: "20", space: "space_1", status: "archived" },
      },
      {
        body: { query: "deployment guidance", runId: "run_1", topK: 10 },
        method: "POST",
        path: "/v1/memory/active-recall",
      },
      {
        body: {
          query: "deployment guidance",
          searchKeys: ["deployment", "operations"],
          space: "space_1",
          strategy: "hybrid-rerank-v1",
          topK: 15,
        },
        method: "POST",
        path: "/v1/memory/evidence/strategy-search",
      },
      {
        body: undefined,
        method: "GET",
        path: "/v1/memory/flushes/run_1",
      },
      {
        body: {
          kind: "workspace",
          name: "Workspace memory",
          retentionDays: 30,
          workspaceId: "workspace_1",
        },
        method: "POST",
        path: "/v1/memory-spaces",
      },
      {
        body: { memoryMode: "workspace", memorySpaceId: "space_1", runId: "run_1" },
        method: "POST",
        path: "/v1/memory/flushes",
      },
      {
        body: {
          agentDefinitionId: "agent_1",
          memorySpaceId: "space_1",
          permission: "read-write",
        },
        method: "POST",
        path: "/v1/memory-space-grants",
      },
      {
        body: { permission: "read" },
        method: "PATCH",
        path: "/v1/memory-space-grants/grant_1",
      },
      {
        body: undefined,
        method: "DELETE",
        path: "/v1/memory-space-grants/grant_1",
      },
      {
        body: { scope: "environment", sensitivityMode: "standard" },
        method: "POST",
        path: "/v1/memory/policies",
      },
      {
        body: {
          activeRecallEnabled: true,
          activeRecallRolloutPercent: 25,
          processingConfig: { extractor: "standard" },
          retentionDays: 90,
          scope: "workspace",
          sensitivityMode: "strict",
          workspaceId: "workspace_1",
        },
        method: "PUT",
        path: "/v1/memory/policies",
      },
      {
        body: { activeRecallEnabled: false },
        method: "PUT",
        path: "/v1/memory/policies",
      },
      {
        body: {
          content: "Updated memory",
          decision: "edit",
          reason: "Corrected after operator review",
        },
        method: "POST",
        path: "/v1/memory/memory_1/review-items/review_1",
      },
      {
        body: { feedback: "Relevant", usefulness: "useful" },
        method: "POST",
        path: "/v1/memory/memory_1/retrievals/retrieval_1/feedback",
      },
      { body: undefined, method: "POST", path: "/v1/memory/memory_1/archive" },
      {
        body: { query: "deployment", space: "space_1", topK: 25 },
        method: "POST",
        path: "/v1/memory/search",
      },
    ]);

    const invalidPage = await harness();
    expect(
      await runCli(
        ["memory", "list", "--page-size", "21", "--env", "env_1", "--mock", "--json"],
        invalidPage,
      ),
    ).toBe(7);
    expect(invalidPage.stderr.join("\n")).toContain("between 1 and 20");
  });
});
