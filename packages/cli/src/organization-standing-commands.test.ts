import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import { ExitCode } from "./exit-codes.ts";
import type { CliIo } from "./types.ts";

const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const WORKSPACE_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
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
  const directory = await mkdtemp(join(tmpdir(), "deployments-cli-standing-"));
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

const organization = `/v1/system/organizations/${ORGANIZATION_ID}`;

describe("organization standing commands", () => {
  it("places and releases an operator hold by key", async () => {
    const placed = await liveCli([
      "system",
      "hold",
      ORGANIZATION_ID,
      "tos-review",
      "--reason",
      "policy",
      "--customer-message",
      "Your organization is under review.",
      "--operator-note",
      "ticket 4411",
    ]);
    const released = await liveCli([
      "system",
      "release",
      ORGANIZATION_ID,
      "tos-review",
      "--release-note",
      "Review closed.",
    ]);

    expect([placed.exitCode, released.exitCode], placed.stderr + released.stderr).toEqual([
      ExitCode.success,
      ExitCode.success,
    ]);
    expect([...placed.requests, ...released.requests]).toEqual([
      {
        body: {
          customerMessage: "Your organization is under review.",
          operatorNote: "ticket 4411",
          reason: "policy",
        },
        method: "PUT",
        path: `${organization}/holds/tos-review`,
      },
      {
        body: { releaseNote: "Review closed." },
        method: "DELETE",
        path: `${organization}/holds/tos-review`,
      },
    ]);
  });

  it("refuses a hold reason outside the closed set", async () => {
    const result = await liveCli([
      "system",
      "hold",
      ORGANIZATION_ID,
      "tos-review",
      "--reason",
      "unpaid",
      "--customer-message",
      "Held.",
    ]);

    expect([result.exitCode === ExitCode.success, result.requests]).toEqual([false, []]);
  });

  it("sends the operator grant's limits and ceiling", async () => {
    const result = await liveCli([
      "system",
      "set-entitlements",
      ORGANIZATION_ID,
      "--tenant-limits",
      '{"concurrentRuns":32}',
      "--model-spend-ceiling",
      '{"monthlyUsdMicros":100000000}',
    ]);

    expect(result.exitCode, result.stderr).toBe(ExitCode.success);
    expect(result.requests).toEqual([
      {
        body: {
          operatorFundedModelSpendCeiling: { monthlyUsdMicros: 100_000_000 },
          tenantLimits: { concurrentRuns: 32 },
        },
        method: "PUT",
        path: `${organization}/entitlements`,
      },
    ]);
  });

  it("sets and clears the data boundary with the operator's note", async () => {
    const set = await liveCli([
      "system",
      "set-data-boundary",
      ORGANIZATION_ID,
      "--profile",
      "phi",
      "--operator-note",
      "BAA 2026-17",
    ]);
    const cleared = await liveCli([
      "system",
      "clear-data-boundary",
      ORGANIZATION_ID,
      "--operator-note",
      "BAA ended",
    ]);

    expect([set.exitCode, cleared.exitCode], set.stderr + cleared.stderr).toEqual([
      ExitCode.success,
      ExitCode.success,
    ]);
    expect([...set.requests, ...cleared.requests]).toEqual([
      {
        body: { operatorNote: "BAA 2026-17", profile: "phi" },
        method: "PUT",
        path: `${organization}/data-boundary`,
      },
      {
        body: { operatorNote: "BAA ended" },
        method: "DELETE",
        path: `${organization}/data-boundary`,
      },
    ]);
  });

  it("refuses a data boundary without a note or outside the known profiles", async () => {
    const results = [
      await liveCli(["system", "set-data-boundary", ORGANIZATION_ID, "--profile", "phi"]),
      await liveCli([
        "system",
        "set-data-boundary",
        ORGANIZATION_ID,
        "--profile",
        "hipaa",
        "--operator-note",
        "BAA",
      ]),
      await liveCli(["system", "clear-data-boundary", ORGANIZATION_ID]),
    ];

    expect(
      results.map(({ exitCode, requests }) => [exitCode === ExitCode.success, requests]),
    ).toEqual([
      [false, []],
      [false, []],
      [false, []],
    ]);
  });

  it("reads standing and its history, and clears the operator grant", async () => {
    const results = [
      await liveCli(["system", "standing", ORGANIZATION_ID]),
      await liveCli(["system", "standing-history", ORGANIZATION_ID, "--page-size", "5"]),
      await liveCli(["system", "clear-entitlements", ORGANIZATION_ID]),
    ];

    expect(results.map(({ exitCode }) => exitCode)).toEqual([
      ExitCode.success,
      ExitCode.success,
      ExitCode.success,
    ]);
    expect(
      results.flatMap(({ requests }) => requests.map(({ method, path }) => [method, path])),
    ).toEqual([
      ["GET", `${organization}/standing`],
      ["GET", `${organization}/standing/history?limit=5`],
      ["DELETE", `${organization}/entitlements`],
    ]);
  });

  it("reads an organization's spend for the current or a named month", async () => {
    const results = [
      await liveCli(["system", "spend", ORGANIZATION_ID]),
      await liveCli(["system", "spend", ORGANIZATION_ID, "--month", "2026-09"]),
      await liveCli([
        "org",
        "spend",
        ORGANIZATION_ID,
        "--org",
        ORGANIZATION_ID,
        "--month",
        "2026-09",
      ]),
    ];

    expect(results.map(({ exitCode }) => exitCode)).toEqual([
      ExitCode.success,
      ExitCode.success,
      ExitCode.success,
    ]);
    expect(
      results.flatMap(({ requests }) => requests.map(({ method, path }) => [method, path])),
    ).toEqual([
      ["GET", `${organization}/spend`],
      ["GET", `${organization}/spend?month=2026-09`],
      ["GET", `/v1/organizations/${ORGANIZATION_ID}/spend?month=2026-09`],
    ]);
  });

  it("reads a workspace's spend and its usage and cost series", async () => {
    const environment = ["--env", ENVIRONMENT_ID];
    const window = ["--since", "2026-10-01T00:00:00.000Z", "--until", "2026-11-01T00:00:00.000Z"];
    const results = [
      await liveCli(["workspace", "spend", WORKSPACE_ID, "--month", "2026-09", ...environment]),
      await liveCli([
        "usage",
        "summary",
        ...window,
        "--workspace-id",
        WORKSPACE_ID,
        ...environment,
      ]),
      await liveCli(["cost", "summary", ...window, "--workspace-id", WORKSPACE_ID, ...environment]),
    ];

    expect(results.map(({ exitCode }) => exitCode)).toEqual([
      ExitCode.success,
      ExitCode.success,
      ExitCode.success,
    ]);
    expect(
      results.flatMap(({ requests }) =>
        requests.map(({ method, path }) => [method, decodeURIComponent(path)]),
      ),
    ).toEqual([
      ["GET", `/v1/workspaces/${WORKSPACE_ID}/spend?month=2026-09`],
      ...["usage", "costs"].map((family) => [
        "GET",
        `/v1/${family}/summary?since=2026-10-01T00:00:00.000Z&until=2026-11-01T00:00:00.000Z&workspaceId=${WORKSPACE_ID}`,
      ]),
    ]);
  });
});

describe("principal status command", () => {
  it("disables a person with a recorded reason", async () => {
    const disabled = await liveCli([
      "system",
      "set-principal-status",
      ORGANIZATION_ID,
      "--status",
      "disabled",
      "--reason",
      "Fraudulent sign-ups",
    ]);

    expect(disabled.exitCode, disabled.stderr).toBe(ExitCode.success);
    expect(disabled.requests).toEqual([
      {
        body: { reason: "Fraudulent sign-ups", status: "disabled" },
        method: "PUT",
        path: `/v1/system/principals/${ORGANIZATION_ID}/status`,
      },
    ]);
  });
});

describe("operator access commands", () => {
  it("opens, shows, lists, and closes operator access", async () => {
    const results = [
      await liveCli([
        "system",
        "access-open",
        ORGANIZATION_ID,
        "--reason",
        "Customer asked for help",
        "--ticket",
        "SUP-7",
        "--duration-minutes",
        "30",
      ]),
      await liveCli(["system", "access-show", ORGANIZATION_ID]),
      await liveCli(["system", "access-list", "--organization-id", ORGANIZATION_ID]),
      await liveCli(["system", "access-close", ORGANIZATION_ID]),
    ];

    expect(
      results.map(({ exitCode }) => exitCode),
      results.map(({ stderr }) => stderr).join(""),
    ).toEqual([ExitCode.success, ExitCode.success, ExitCode.success, ExitCode.success]);
    expect(results.flatMap(({ requests }) => requests)).toEqual([
      {
        body: { durationMinutes: 30, reason: "Customer asked for help", ticket: "SUP-7" },
        method: "PUT",
        path: `${organization}/operator-access`,
      },
      { body: undefined, method: "GET", path: `${organization}/operator-access` },
      {
        body: undefined,
        method: "GET",
        path: `/v1/system/operator-access?organizationId=${ORGANIZATION_ID}`,
      },
      { body: undefined, method: "DELETE", path: `${organization}/operator-access` },
    ]);
  });
});
