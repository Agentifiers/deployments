import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { organizationCommandCatalog } from "./catalog-organization.ts";
import { runCli } from "./cli.ts";
import { buildRequest } from "./command-runtime.ts";
import type { ResolvedCliContext } from "./types.ts";

const directories: string[] = [];
const context: ResolvedCliContext = {
  apiKey: "token",
  apiUrl: "https://api.example.com",
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  mock: false,
  profileName: "default",
};
const grantCreate = organizationCommandCatalog.grant!.actions.create!;
const grant = {
  connection: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
  purpose: "agent-runtime",
  scopes: "callback:draft:propose",
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function bodyOf(args: Readonly<Record<string, boolean | string>>) {
  return (await buildRequest(grantCreate, args, context, {})).body;
}

describe("grant create", () => {
  test("--workspace grants one workspace", async () => {
    expect(await bodyOf({ ...grant, workspace: "01ARZ3NDEKTSV4RRFFQ69G5FB1" })).toEqual({
      connectionId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      purpose: "agent-runtime",
      scopes: ["callback:draft:propose"],
      workspaceId: "01ARZ3NDEKTSV4RRFFQ69G5FB1",
    });
  });

  test("--all-workspaces sends a null workspace for an environment grant", async () => {
    expect(await bodyOf({ ...grant, "all-workspaces": true })).toEqual({
      connectionId: "01ARZ3NDEKTSV4RRFFQ69G5FB0",
      purpose: "agent-runtime",
      scopes: ["callback:draft:propose"],
      workspaceId: null,
    });
  });

  test("needs exactly one of --workspace and --all-workspaces", async () => {
    const failures = await Promise.all(
      [
        bodyOf(grant),
        bodyOf({ ...grant, "all-workspaces": true, workspace: "01ARZ3NDEKTSV4RRFFQ69G5FB1" }),
      ].map((pending) =>
        pending.then(
          () => "accepted",
          (cause: unknown) => (cause instanceof Error ? cause.message : cause),
        ),
      ),
    );
    expect(failures).toEqual([
      "Provide --workspace or --all-workspaces.",
      "Choose either --workspace or --all-workspaces.",
    ]);
  });

  test("exits with the usage code when both reach flags are given", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deployments-cli-grant-"));
    directories.push(directory);
    const stderr: string[] = [];
    const exitCode = await runCli(
      [
        "grant",
        "create",
        "--mock",
        "--connection",
        grant.connection,
        "--purpose",
        grant.purpose,
        "--scopes",
        grant.scopes,
        "--workspace",
        "01ARZ3NDEKTSV4RRFFQ69G5FB1",
        "--all-workspaces",
      ],
      {
        env: { DEPLOYMENTS_CONFIG_DIR: directory, NO_COLOR: "1" },
        io: { isInteractive: false, stderr: (value) => stderr.push(value), stdout: () => {} },
      },
    );

    expect(exitCode).toBe(2);
    expect(stderr.join("")).toContain("Choose either --workspace or --all-workspaces.");
  });
});
