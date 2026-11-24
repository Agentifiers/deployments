import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluationCommandCatalog } from "./catalog-evaluations.ts";
import { runCli } from "./cli.ts";
import { buildRequest } from "./command-runtime.ts";
import type { ResolvedCliContext } from "./types.ts";

const context: ResolvedCliContext = {
  apiKey: "token",
  apiUrl: "https://api.example.com",
  environmentId: "environment-1",
  mock: false,
  organizationId: "organization-1",
  profileName: "default",
  projectId: "project-1",
};
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

test("eval case import sends the JSON case file as idempotent tenant-scoped cases", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eval-cases-"));
  directories.push(directory);
  const file = join(directory, "cases.json");
  const cases = [
    { expected: { mustInclude: ["refund"], tone: "calm" }, id: "refund", message: "Refund?" },
    { message: "Cancel", tags: ["billing"] },
  ];
  await writeFile(file, JSON.stringify(cases));
  const importCases = evaluationCommandCatalog["eval-case"]!.actions.import!;

  const request = await buildRequest(importCases, { dataset: "dataset 1", file }, context, {});
  expect(request).toMatchObject({
    body: { cases },
    context: {
      environmentId: "environment-1",
      organizationId: "organization-1",
      projectId: "project-1",
    },
    method: "POST",
    path: "/v1/regression-datasets/dataset%201/cases/import",
  });
  expect(request.idempotencyKey).toBeString();
  expect(buildRequest(importCases, { dataset: "dataset-1" }, context, {})).rejects.toThrow(
    "--file",
  );
});

test("eval run and comparison create parse JSON, list, and numeric arguments", async () => {
  const run = await buildRequest(
    evaluationCommandCatalog["eval-run"]!.actions.create!,
    {
      "case-timeout": "120",
      concurrency: "3",
      dataset: "dataset-1",
      kind: "dataset-replay",
      "score-definitions": "definition-1,definition-2",
      target: '{"type":"release","agentReleaseId":"release-1"}',
    },
    context,
    {},
  );
  expect(run.body).toEqual({
    caseTimeoutSeconds: 120,
    concurrency: 3,
    datasetId: "dataset-1",
    kind: "dataset-replay",
    scoreDefinitionIds: ["definition-1", "definition-2"],
    target: { agentReleaseId: "release-1", type: "release" },
  });

  const comparison = await buildRequest(
    evaluationCommandCatalog["eval-comparison"]!.actions.create!,
    {
      baseline: "release-1",
      candidate: "release-2",
      dataset: "dataset-1",
      "gate-policy": '{"maxNewFailures":1}',
      "score-definitions": "definition-1",
    },
    context,
    {},
  );
  expect(comparison.body).toEqual({
    baselineReleaseId: "release-1",
    candidateReleaseId: "release-2",
    datasetId: "dataset-1",
    gatePolicy: { maxNewFailures: 1 },
    scoreDefinitionIds: ["definition-1"],
  });

  const results = await buildRequest(
    evaluationCommandCatalog["eval-run"]!.actions.results!,
    { id: "run-1", "page-size": "100" },
    context,
    {},
  );
  expect(results).toMatchObject({
    path: "/v1/evaluation-runs/run-1/results",
    query: { limit: 100 },
  });
  expect(results.idempotencyKey).toBeUndefined();
});

test("eval run and comparison list map filter flags to contract query fields", async () => {
  const runs = await buildRequest(
    evaluationCommandCatalog["eval-run"]!.actions.list!,
    { dataset: "dataset-1", release: "release-1", status: "running", "page-size": "20" },
    context,
    {},
  );
  expect(runs).toMatchObject({
    method: "GET",
    path: "/v1/evaluation-runs",
    query: { agentReleaseId: "release-1", datasetId: "dataset-1", limit: 20, status: "running" },
  });

  const comparisons = await buildRequest(
    evaluationCommandCatalog["eval-comparison"]!.actions.list!,
    { baseline: "release-1", candidate: "release-2", status: "completed" },
    context,
    {},
  );
  expect(comparisons).toMatchObject({
    method: "GET",
    path: "/v1/release-comparisons",
    query: { baselineReleaseId: "release-1", candidateReleaseId: "release-2", status: "completed" },
  });
});

test("evaluation resources run only under the eval namespace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eval-cli-"));
  directories.push(directory);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const runtime = {
    env: { DEPLOYMENTS_CONFIG_DIR: directory, DEPLOYMENTS_MOCK: "1", NO_COLOR: "1" },
    io: {
      isInteractive: false,
      stderr: (value: string) => void stderr.push(value),
      stdout: (value: string) => void stdout.push(value),
    },
  };
  expect(await runCli(["eval", "dataset", "list", "--json"], runtime)).toBe(0);
  expect(JSON.parse(stdout[0]!).items[0]).toMatchObject({ name: "support-regressions" });
  expect(await runCli(["eval-dataset", "list", "--json"], runtime)).not.toBe(0);
  expect(stderr.join("\n")).toContain("Unknown command: eval-dataset");
});
