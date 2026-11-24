import { MOCK_TENANCY_FIXTURE_IDS } from "@agentifiers/deployments-sdk";
import { afterEach, describe, expect, it } from "bun:test";
import { runCli } from "./cli.ts";
import { harness, removeTemporaryDirectories } from "./cli-test-harness.ts";
import { ExitCode } from "./exit-codes.ts";

const temporaryServers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  await Promise.all(temporaryServers.splice(0).map((server) => server.stop(true)));
  await removeTemporaryDirectories();
});

async function liveCli(args: readonly string[]) {
  const requests: { body: unknown; method: string; pathname: string }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const text = await request.text();
      requests.push({
        body: text ? (JSON.parse(text) as unknown) : undefined,
        method: request.method,
        pathname: new URL(request.url).pathname,
      });
      return Response.json({ erasureId: "erasure_1" }, { status: 202 });
    },
  });
  temporaryServers.push(server);
  const { directory, io, stderr } = await harness();
  const exitCode = await runCli(
    [
      ...args,
      "--live",
      "--api-url",
      server.url.toString(),
      "--env",
      MOCK_TENANCY_FIXTURE_IDS.environment,
      "--json",
      "--yes",
    ],
    { env: { DEPLOYMENTS_CONFIG_DIR: directory, NO_COLOR: "1" }, io },
  );
  return { exitCode, requests, stderr };
}

describe("end-user erase", () => {
  it("sends the canonical email subject for --email", async () => {
    const result = await liveCli(["end-user", "erase", "--email", " Alice@Example.com "]);

    expect(result.exitCode).toBe(ExitCode.success);
    expect(result.requests).toEqual([
      {
        body: { endUserId: "channel:email:-:alice%40example.com" },
        method: "POST",
        pathname: "/v1/end-users/erasures",
      },
    ]);
  });

  it("still sends --end-user-id unchanged", async () => {
    const result = await liveCli(["end-user", "erase", "--end-user-id", "customer-42"]);

    expect(result.exitCode).toBe(ExitCode.success);
    expect(result.requests.map((request) => request.body)).toEqual([{ endUserId: "customer-42" }]);
  });

  it("refuses --email together with --end-user-id without sending a request", async () => {
    const result = await liveCli([
      "end-user",
      "erase",
      "--email",
      "alice@example.com",
      "--end-user-id",
      "customer-42",
    ]);

    expect(result.exitCode).toBe(ExitCode.validation);
    expect(result.requests).toEqual([]);
    expect(result.stderr.join("")).toContain("Conflicting values were provided for endUserId.");
  });
});
