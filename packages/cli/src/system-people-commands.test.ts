import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import { ExitCode } from "./exit-codes.ts";
import type { CliIo } from "./types.ts";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const temporaryDirectories: string[] = [];
const temporaryServers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  await Promise.all(temporaryServers.splice(0).map((server) => server.stop(true)));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function liveCli(args: readonly string[]) {
  const requests: { body: unknown; method: string; path: string }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const text = await request.text();
      const url = new URL(request.url);
      requests.push({
        body: text ? (JSON.parse(text) as unknown) : undefined,
        method: request.method,
        path: `${url.pathname}${url.search}`,
      });
      return Response.json({ items: [], nextCursor: null });
    },
  });
  temporaryServers.push(server);
  const directory = await mkdtemp(join(tmpdir(), "deployments-cli-people-"));
  temporaryDirectories.push(directory);
  const stderr: string[] = [];
  const io: CliIo = {
    isInteractive: false,
    stderr: (value) => stderr.push(value),
    stdout: () => {},
  };
  const exitCode = await runCli(
    [...args, "--live", "--api-url", server.url.toString(), "--json", "--yes"],
    { env: { DEPLOYMENTS_CONFIG_DIR: directory, NO_COLOR: "1" }, io },
  );
  return { exitCode, requests, stderr: stderr.join("\n") };
}

const principal = `/v1/system/principals/${PRINCIPAL_ID}`;

describe("system people commands", () => {
  it("finds, shows, and lists a person's security events", async () => {
    const runs = [
      await liveCli(["system", "people", "find", "--email", "ada@example.com"]),
      await liveCli(["system", "people", "show", PRINCIPAL_ID]),
      await liveCli(["system", "people", "events", PRINCIPAL_ID, "--page-size", "20"]),
    ];

    expect(
      runs.map((run) => run.exitCode),
      runs.map((run) => run.stderr).join("\n"),
    ).toEqual([ExitCode.success, ExitCode.success, ExitCode.success]);
    expect(runs.flatMap((run) => run.requests)).toEqual([
      {
        body: undefined,
        method: "GET",
        path: "/v1/system/principals?email=ada%40example.com",
      },
      { body: undefined, method: "GET", path: principal },
      { body: undefined, method: "GET", path: `${principal}/security-events?limit=20` },
    ]);
  });

  it("ends sessions and resends verification with the operator's reason", async () => {
    const revoked = await liveCli([
      "system",
      "people",
      "revoke-sessions",
      PRINCIPAL_ID,
      "--reason",
      "Lost laptop",
    ]);
    const resent = await liveCli([
      "system",
      "people",
      "resend-verification",
      PRINCIPAL_ID,
      "--email",
      "ada@example.com",
      "--reason",
      "Email went to spam",
    ]);

    expect([revoked.exitCode, resent.exitCode], revoked.stderr + resent.stderr).toEqual([
      ExitCode.success,
      ExitCode.success,
    ]);
    expect([...revoked.requests, ...resent.requests]).toEqual([
      { body: { reason: "Lost laptop" }, method: "POST", path: `${principal}/sessions/revoke` },
      {
        body: { email: "ada@example.com", reason: "Email went to spam" },
        method: "POST",
        path: `${principal}/verification-email`,
      },
    ]);
  });

  it("refuses to end sessions without a reason", async () => {
    const result = await liveCli(["system", "people", "revoke-sessions", PRINCIPAL_ID]);

    expect([result.exitCode === ExitCode.success, result.requests]).toEqual([false, []]);
  });
});
