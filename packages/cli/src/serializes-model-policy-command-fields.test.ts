import { MOCK_TENANCY_FIXTURE_IDS } from "@agentifiers/deployments-sdk";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.ts";
import { ExitCode } from "./exit-codes.ts";
import type { CliIo } from "./types.ts";

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
  readonly url: URL;
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
        url: new URL(request.url),
      });
      return Response.json(
        request.method === "GET" ? { items: [], nextCursor: null } : { id: "policy" },
      );
    },
  });
  temporaryServers.push(server);
  const directory = await mkdtemp(join(tmpdir(), "deployments-cli-models-"));
  temporaryDirectories.push(directory);
  const stderr: string[] = [];
  const io: CliIo = {
    isInteractive: false,
    stderr: (value) => stderr.push(value),
    stdout: () => {},
  };
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

describe("model CLI commands", () => {
  it("collects every repeated --model value and honors negated curated admission", async () => {
    const created = await liveCli([
      "model-policy",
      "create",
      "--name",
      "Hosted catalog",
      "--no-include-curated-models",
      "--model",
      "openrouter/mistralai/mistral-small-3.2-24b-instruct",
      "--model=openai/*",
    ]);
    expect(created.exitCode, created.stderr.join("\n")).toBe(ExitCode.success);
    expect(created.requests).toHaveLength(1);
    expect(created.requests[0]!.body).toEqual({
      includeCuratedModels: false,
      models: ["openrouter/mistralai/mistral-small-3.2-24b-instruct", "openai/*"],
      name: "Hosted catalog",
    });

    const updated = await liveCli([
      "model-policy",
      "update",
      MOCK_TENANCY_FIXTURE_IDS.agentDefinition,
      "--expected-version",
      "3",
      "--models",
      '["openrouter/*"]',
    ]);
    expect(updated.exitCode, updated.stderr.join("\n")).toBe(ExitCode.success);
    expect(updated.requests[0]).toMatchObject({
      body: { expectedVersion: 3, models: ["openrouter/*"] },
      method: "PATCH",
    });
    expect(updated.requests[0]!.body).not.toHaveProperty("includeCuratedModels");
  });

  it("rejects ambiguous or incomplete policy rules before sending a request", async () => {
    const conflicting = await liveCli([
      "model-policy",
      "create",
      "--name",
      "Ambiguous",
      "--include-curated-models",
      "--model",
      "openai/*",
      "--models",
      '["openrouter/*"]',
    ]);
    expect(conflicting.exitCode).toBe(ExitCode.validation);
    expect(conflicting.requests).toHaveLength(0);

    const missingCuratedChoice = await liveCli([
      "model-policy",
      "create",
      "--name",
      "Undecided",
      "--model",
      "openai/*",
    ]);
    expect(missingCuratedChoice.exitCode).not.toBe(ExitCode.success);
    expect(missingCuratedChoice.requests).toHaveLength(0);
  });

  it("sends catalog filters as typed list query parameters", async () => {
    const listed = await liveCli([
      "model",
      "list",
      "--provider",
      "openrouter",
      "--capability",
      "tool_calling",
      "--no-curated",
      "--allowed",
      "--search",
      "mistral",
      "--page-size",
      "25",
    ]);
    expect(listed.exitCode, listed.stderr.join("\n")).toBe(ExitCode.success);
    expect(Object.fromEntries(listed.requests[0]!.url.searchParams)).toEqual({
      allowed: "true",
      capability: "tool_calling",
      curated: "false",
      limit: "25",
      provider: "openrouter",
      search: "mistral",
    });

    const invalid = await liveCli(["model", "list", "--provider", "anthropic"]);
    expect(invalid.exitCode).not.toBe(ExitCode.success);
    expect(invalid.requests).toHaveLength(0);
  });

  it("prints model token limits and prices instead of redacting them as secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "deployments-cli-models-"));
    temporaryDirectories.push(directory);
    const stdout: string[] = [];
    const io: CliIo = {
      isInteractive: false,
      stderr: () => {},
      stdout: (value) => stdout.push(value),
    };
    expect(
      await runCli(
        [
          "model",
          "list",
          "--mock",
          "--env",
          MOCK_TENANCY_FIXTURE_IDS.environment,
          "--search",
          "gemini",
          "--json",
        ],
        { env: { DEPLOYMENTS_CONFIG_DIR: directory, NO_COLOR: "1" }, io },
      ),
    ).toBe(ExitCode.success);
    expect(JSON.parse(stdout.join(""))).toMatchObject({
      items: [
        {
          contextWindowTokens: expect.any(Number),
          maximumOutputTokens: expect.any(Number),
          pricing: {
            inputUsdPerMillionTokens: expect.any(Number),
            outputUsdPerMillionTokens: expect.any(Number),
            tiers: [
              {
                inputUsdPerMillionTokens: expect.any(Number),
                minPromptTokens: expect.any(Number),
                outputUsdPerMillionTokens: expect.any(Number),
              },
            ],
          },
        },
      ],
    });
  });
});
