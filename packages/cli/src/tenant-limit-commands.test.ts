import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import { ExitCode } from "./exit-codes.ts";
import type { CliIo } from "./types.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
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

interface CapturedRequest {
  readonly body: unknown;
  readonly method: string;
  readonly organizationHeader: string | null;
  readonly path: string;
}

async function liveCli(args: readonly string[]) {
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const text = await request.text();
      requests.push({
        body: text ? (JSON.parse(text) as unknown) : undefined,
        method: request.method,
        organizationHeader: request.headers.get("x-deployments-organization"),
        path: new URL(request.url).pathname,
      });
      return Response.json({ organizationId: ORGANIZATION_ID });
    },
  });
  temporaryServers.push(server);
  const directory = await mkdtemp(join(tmpdir(), "deployments-cli-limits-"));
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

describe("organization limit commands", () => {
  it("reads the selected organization's effective limits", async () => {
    const result = await liveCli(["org", "limits", ORGANIZATION_ID, "--org", ORGANIZATION_ID]);

    expect(result.exitCode, result.stderr).toBe(ExitCode.success);
    expect(result.requests).toEqual([
      {
        body: undefined,
        method: "GET",
        organizationHeader: ORGANIZATION_ID,
        path: `/v1/organizations/${ORGANIZATION_ID}/limits`,
      },
    ]);
  });

  it("reads the selected organization's standing", async () => {
    const result = await liveCli(["org", "standing", ORGANIZATION_ID, "--org", ORGANIZATION_ID]);

    expect(result.exitCode, result.stderr).toBe(ExitCode.success);
    expect(result.requests).toEqual([
      {
        body: undefined,
        method: "GET",
        organizationHeader: ORGANIZATION_ID,
        path: `/v1/organizations/${ORGANIZATION_ID}/standing`,
      },
    ]);
  });
});
