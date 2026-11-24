import { expect, it } from "@effect/vitest";
import { commandCatalog } from "@agentifiers/deployments-cli/catalog";
import { Effect } from "effect";
import { CliProcess, CliProcessLive, makeTemporaryCliConfig } from "../harness/cli-process.ts";

interface CatalogRow {
  readonly command: string;
  readonly summary: string;
}

const BUILT_IN_COMMANDS = [
  "auth login",
  "auth logout",
  "context show",
  "context set",
  "context clear",
  "whoami",
  "chat",
  "dev",
  "health",
  "openapi",
  "catalog",
  "tool upload",
] as const;

const RESOURCE_COMMANDS = Object.entries(commandCatalog).flatMap(([resource, definition]) => {
  const command = definition.namespace
    ? `${definition.namespace.name} ${definition.namespace.command}`
    : resource;
  return Object.keys(definition.actions).map((action) => `${command} ${action}`);
});
const EXPECTED_COMMANDS = [...BUILT_IN_COMMANDS, ...RESOURCE_COMMANDS];

function parseCatalog(stdout: string): CatalogRow[] {
  const value = JSON.parse(stdout) as unknown;
  if (!Array.isArray(value)) throw new TypeError("CLI catalog was not a JSON array.");
  return value.map((row) => {
    if (
      !row ||
      typeof row !== "object" ||
      typeof (row as { command?: unknown }).command !== "string" ||
      typeof (row as { summary?: unknown }).summary !== "string"
    ) {
      throw new TypeError("CLI catalog contained a malformed row.");
    }
    return row as CatalogRow;
  });
}

it.effect("spawns the real CLI and exposes every command in its machine-readable catalog", () =>
  Effect.gen(function* () {
    const cli = yield* CliProcess;
    const configDirectory = yield* makeTemporaryCliConfig;
    const result = yield* cli.run({
      args: ["catalog", "--json", "--no-color"],
      env: { DEPLOYMENTS_CONFIG_DIR: configDirectory },
    });
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    const rows = parseCatalog(result.stdout);
    expect(rows.map((row) => row.command)).toEqual(
      EXPECTED_COMMANDS.map((command) => `deployments ${command}`),
    );
    expect(new Set(rows.map((row) => row.command)).size).toBe(rows.length);
  }).pipe(Effect.provide(CliProcessLive)),
);

it.effect(
  "renders executable help successfully for every public CLI command",
  () =>
    Effect.gen(function* () {
      const cli = yield* CliProcess;
      const configDirectory = yield* makeTemporaryCliConfig;
      const results = yield* Effect.forEach(
        EXPECTED_COMMANDS,
        (command) =>
          cli
            .run({
              args: [...command.split(" "), "--help"],
              env: { DEPLOYMENTS_CONFIG_DIR: configDirectory },
            })
            .pipe(Effect.map((result) => ({ command, result }))),
        { concurrency: 8 },
      );
      const failures = results.filter(({ result }) => result.exitCode !== 0);
      expect(failures.map(({ command, result }) => ({ command, stderr: result.stderr }))).toEqual(
        [],
      );
      for (const { command, result } of results) {
        expect(result.stdout, `${command} should render usage`).toContain("USAGE");
        expect(result.stderr, `${command} should not emit stderr`).toBe("");
      }
    }).pipe(Effect.provide(CliProcessLive)),
  // One process per command: two-vCPU CI runners need about two minutes.
  300_000,
);
