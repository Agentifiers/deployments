import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SYSTEM_OBSERVER_ROUTES } from "@deployments-ai/api-contract/system";
import { Schema } from "effect";
import { deploymentArtifacts, deploymentStaticAssets } from "./build-deployment-artifacts.ts";
import { DeployEvent } from "./platform-deploy/deploy-events.ts";
import { deployStages } from "./platform-deploy/deploy-stages.ts";
import { endpointOutputs } from "./platform-deploy/installation-record.ts";
import { targetVariables } from "./platform-deploy/pipeline.ts";
import { repositoryRoot } from "./platform-deploy/process.ts";
import {
  platformImageNames,
  platformImages,
  rootProfileNames,
  rootProfiles,
} from "./platform-deploy/profiles.ts";
import { ReleaseManifestDocument } from "./platform-deploy/release-bundle.ts";
import {
  ReleaseRecord,
  ReleaseRecordSignature,
} from "./platform-deploy/release-registry/record.ts";
import { DeploymentTargetDocument } from "./platform-deploy/target.ts";

export const byocContractFile = "contracts/byoc-contract.json";

const variableBlock = /^variable "([^"]+)" \{(?:\}|\n([\s\S]*?)^\})$/gmu;

export async function terraformRequiredVariables(directory: string) {
  const files = await readdir(directory);
  const unreadable = files.find((name) => /(?:\.tf\.json|(?:^|_)override\.tf)$/u.test(name));
  if (unreadable) {
    throw new Error(`${join(directory, unreadable)} is an OpenTofu file the exporter cannot read.`);
  }
  const required: string[] = [];
  for (const file of files.filter((name) => name.endsWith(".tf"))) {
    const path = join(directory, file);
    const source = await readFile(path, "utf8");
    if (/^\s*\/\*/mu.test(source)) {
      throw new Error(`${path} has a block comment the exporter cannot read.`);
    }
    const blocks = [...source.matchAll(variableBlock)];
    if (blocks.length !== (source.match(/^variable /gmu)?.length ?? 0)) {
      throw new Error(`${path} has a variable block that is not tofu fmt.`);
    }
    for (const [, name = "", body = ""] of blocks) {
      if (body.includes("<<")) {
        throw new Error(`variable "${name}" in ${path} has a heredoc the exporter cannot read.`);
      }
      if (!/^ {2}default\s*=/mu.test(body)) required.push(name);
    }
  }
  return required.toSorted();
}

export async function byocContract() {
  const writtenByDeploy: ReadonlySet<string> = new Set(targetVariables);
  return {
    releaseManifestVersion: ReleaseManifestDocument.fields.version.literal,
    artifacts: Object.keys(deploymentArtifacts),
    assets: Object.keys(deploymentStaticAssets),
    images: platformImageNames.map((name) => ({ name, platform: platformImages[name].platform })),
    rootProfiles: rootProfileNames.map((name) => ({ name, ...rootProfiles[name] })),
    deployStages,
    endpoints: Object.values(endpointOutputs),
    observerRoutes: SYSTEM_OBSERVER_ROUTES.map(({ method, path }) => ({ method, path })),
    customerRootRequiredVariables: (
      await terraformRequiredVariables(
        join(repositoryRoot, rootProfiles["platform-customer"].terraformRoot),
      )
    ).filter((name) => !writtenByDeploy.has(name)),
    schemas: {
      target: Schema.toJsonSchemaDocument(DeploymentTargetDocument),
      releaseManifest: Schema.toJsonSchemaDocument(ReleaseManifestDocument),
      releaseRecord: Schema.toJsonSchemaDocument(ReleaseRecord),
      releaseRecordSignature: Schema.toJsonSchemaDocument(ReleaseRecordSignature),
      deployEvent: Schema.toJsonSchemaDocument(DeployEvent),
    },
  };
}

if (import.meta.main) {
  const path = join(repositoryRoot, byocContractFile);
  const content = `${JSON.stringify(await byocContract(), null, 2)}\n`;
  if (process.argv.includes("--check")) {
    const committed = await readFile(path, "utf8");
    if (committed !== content) {
      process.stderr.write(`${byocContractFile} is stale. Run bun run contract:export.\n`);
      process.exitCode = 1;
    }
  } else {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    process.stdout.write(`${byocContractFile}\n`);
  }
}
