import { afterEach, describe, expect, it } from "bun:test";
import type { ApprovalResponse, ToolCallResponse } from "@deployments-ai/api-contract/runtime";
import { runCli } from "./cli.ts";
import { harness, removeTemporaryDirectories } from "./cli-test-harness.ts";
import { DevRenderer } from "./dev/render.ts";
import type { CliIo } from "./types.ts";

const LONG_URL = `https://labs.example.org/patients/${"a".repeat(120)}?mrn=12345&visit=2026-11-14`;
const DESTINATIONS = [LONG_URL, "recipient +15550000002", 'search query "flu clinic hours"'];
const APPROVAL = {
  id: "approval_1",
  object: "approval",
  request: {
    destinations: DESTINATIONS,
    effect: "external",
    inputSummary: "Scrape a page",
    toolName: "web.scrape",
  },
  runId: "run_1",
  status: "pending",
};
const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  await removeTemporaryDirectories();
});

async function humanCli(args: readonly string[], body: unknown) {
  const server = Bun.serve({ port: 0, fetch: () => Response.json(body) });
  servers.push(server);
  const test = await harness();
  const exitCode = await runCli(
    [...args, "--live", "--api-url", server.url.toString(), "--env", "env_1", "--yes"],
    { env: { DEPLOYMENTS_CONFIG_DIR: test.directory, NO_COLOR: "1" }, io: test.io },
  );
  return { exitCode, stdout: test.stdout };
}

/** Each destination printed whole on its own line, after the approval's heading. */
function expectEveryDestination(stdout: readonly string[]) {
  const heading = stdout.indexOf("Approval approval_1 sends data to these destinations:");
  expect(heading).toBeGreaterThanOrEqual(0);
  expect(stdout.slice(heading + 1, heading + 4)).toEqual(DESTINATIONS.map((line) => `  ${line}`));
}

describe("approval destinations in CLI output", () => {
  it("approval show prints every destination in full", async () => {
    const result = await humanCli(["approval", "show", "approval_1", "--run", "run_1"], APPROVAL);
    expect(result.exitCode).toBe(0);
    expectEveryDestination(result.stdout);
  });

  it("approval list prints every destination of each approval", async () => {
    const result = await humanCli(["approval", "list"], { approvals: [APPROVAL] });
    expect(result.exitCode).toBe(0);
    expectEveryDestination(result.stdout);
  });

  it("approval approve prints the destinations it approved", async () => {
    const result = await humanCli(
      ["approval", "approve", "approval_1", "--run", "run_1", "--thread", "thread_1"],
      { approval: { ...APPROVAL, status: "approved" }, decision: "approved" },
    );
    expect(result.exitCode).toBe(0);
    expectEveryDestination(result.stdout);
  });

  it("prints nothing extra for an approval without destinations", async () => {
    const { destinations: _destinations, ...request } = APPROVAL.request;
    const result = await humanCli(["approval", "show", "approval_1", "--run", "run_1"], {
      ...APPROVAL,
      request,
    });
    expect(result.stdout.join("\n")).not.toContain("destinations:");
  });

  it("the dev approval prompt prints every destination before the decision", () => {
    const stdout: string[] = [];
    const io = {
      stderr: () => {},
      stdout: (line: string) => stdout.push(line),
    } as unknown as CliIo;
    new DevRenderer(io, false).approval(
      APPROVAL as unknown as ApprovalResponse,
      {
        effect: "external",
        inputSummary: "Scrape a page",
        toolName: "web.scrape",
      } as unknown as ToolCallResponse,
    );
    expect(stdout[0]).toContain("needs approval approval_1");
    expectEveryDestination(stdout);
  });
});
