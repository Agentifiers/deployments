import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MODEL_GATEWAY_ENV_KEYS } from "../packages/model-gateway/src/types.ts";
import { blockAt } from "./terraform-files.ts";

const moduleDirectory = "infrastructure/modules/platform-api";
const runtime = readFileSync(`${moduleDirectory}/governance-runtime.tf`, "utf8");
const main = readFileSync(`${moduleDirectory}/main.tf`, "utf8");
const platformApi = readFileSync("infrastructure/modules/platform/identity-and-api.tf", "utf8");
const brainOutputs = readFileSync("infrastructure/modules/brain-runtime/outputs.tf", "utf8");
const appOutputs = readFileSync("infrastructure/modules/app-runtime/outputs.tf", "utf8");

const variableNames = (source: string) =>
  [...source.matchAll(/\b([A-Z][A-Z0-9_]+)\s+=\s/gu)].map(([, name]) => name!);

function segments(block: string, indent: string) {
  const starts = [...block.matchAll(new RegExp(`^${indent}(\\w+) +=`, "gmu"))];
  return Object.fromEntries(
    starts.map((match, index) => [match[1]!, block.slice(match.index, starts[index + 1]?.index)]),
  );
}

const locals = segments(blockAt(runtime, runtime.indexOf("locals {")), "  ");
const externalMaps = {
  "var.apps_runtime.environment": [
    ...variableNames(blockAt(appOutputs, appOutputs.indexOf("environment = {"))),
    ...variableNames(blockAt(platformApi, platformApi.indexOf("platform_api_apps_runtime = "))),
  ],
  "var.brain_runtime_environment_variables": [
    ...variableNames(blockAt(brainOutputs, brainOutputs.indexOf('output "runtime_configuration"'))),
    ...variableNames(/^\s*brain_runtime_environment_variables\s+=.*$/mu.exec(platformApi)![0]),
  ],
};

const provided = Object.fromEntries(
  Object.entries(segments(locals["api_environment"]!, "    ")).map(([key, source]) => {
    const names = [
      ...variableNames(source),
      ...[...source.matchAll(/local\.(api_\w+_environment)\b/gu)].flatMap(([, local]) =>
        variableNames(locals[local!]!),
      ),
      ...Object.entries(externalMaps).flatMap(([reference, mapNames]) =>
        source.includes(reference) ? mapNames : [],
      ),
    ];
    return [key, [...new Set(names)].sort()];
  }),
);
const handlerModules = Object.fromEntries(
  Object.entries(segments(blockAt(main, main.indexOf("api_functions = {")), "    ")).map(
    ([key, source]) => [key, /handler\s+=\s+"([\w-]+)\.handler"/u.exec(source)![1]!],
  ),
);

const modelGatewayNames: readonly string[] = [
  MODEL_GATEWAY_ENV_KEYS.baseUrl[0],
  MODEL_GATEWAY_ENV_KEYS.defaultFallbackModelIds[0],
  MODEL_GATEWAY_ENV_KEYS.tokenIssuer[0],
];

test("gives each platform API function exactly the variables its handler reads", () => {
  // A second Bun.build inside the test process cannot resolve the workspace packages.
  const outdir = mkdtempSync(join(tmpdir(), "platform-api-bundles-"));
  const build = Bun.spawnSync(
    [
      "bun",
      "build",
      ...Object.values(handlerModules).map((module) => `src/${module}.ts`),
      "--root=src",
      "--target=node",
      "--format=esm",
      `--outdir=${outdir}`,
    ],
    { cwd: "functions/api", stderr: "pipe", stdout: "ignore" },
  );
  if (!build.success) throw new Error(build.stderr.toString());

  const candidates = [...new Set(Object.values(provided).flat())];
  const read = Object.fromEntries(
    Object.entries(handlerModules).map(([key, module]) => {
      const bundle = readFileSync(join(outdir, `${module}.js`), "utf8");
      const readsTables = bundle.includes("`DEPLOYMENTS_AI_${table");
      // Every bundle carries the model-gateway key table; only a caller of this reader reads the keys.
      const readsModelGateway = bundle.split("modelGatewayRouteDefaultsFromEnv(").length > 2;
      const names = candidates.filter(
        (name) =>
          (bundle.includes(`"${name}"`) || (readsTables && name.endsWith("_TABLE"))) &&
          (readsModelGateway || !modelGatewayNames.includes(name)),
      );
      return [key, names.sort()];
    }),
  );

  expect(Object.keys(read).sort()).toEqual([
    "administration",
    "brain",
    "budget",
    "evaluations",
    "governance",
    "monitors",
    "observability",
    "system",
    "tenancy",
  ]);
  expect(read["tenancy"]).toContain("APPS_DOMAIN");
  expect(read["brain"]).toContain("DEPLOYMENTS_AI_MODEL_GATEWAY_BASE_URL");
  expect(read["governance"]).toContain("DEPLOYMENTS_AI_GOVERNANCE_QUEUE_URL");
  expect(provided).toEqual(read);
}, 60_000);
