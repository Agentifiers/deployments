import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { runBootstrap } from "@deployments-ai/app-database";
import { bootstrapAppDatabase } from "./app-database-bootstrap.ts";
import { publishConsoleAssets } from "./console-assets.ts";
import { bootstrapIdentityClients } from "./identity-clients.ts";
import { ssmIdentityMarkerReader } from "./identity-domain.ts";
import { publishImages } from "./images.ts";
import { dynamoPlatformTables, recordInstallation } from "./installation-record.ts";
import { publishLambdaArtifacts } from "./lambda-artifacts.ts";
import { deployLambdaRelease } from "./lambda-release.ts";
import { publishMicrovmImage, verifyLambdaMicrovmRuntime } from "./microvm.ts";
import { syncModelRuntimeSecrets } from "./model-runtime-secrets.ts";
import {
  recheckGovernanceInventoryShards,
  switchGovernanceInventoryShardWrites,
} from "./governance-inventory-shards-migration.ts";
import { migrateArtifactCreationIndex } from "./artifact-creation-index-migration.ts";
import { migrateMeterEventWorkspaces } from "./meter-event-workspaces-migration.ts";
import { migrateOrganizationLimits } from "./organization-limits-migration.ts";
import { reconcileOrganizationGateLanes } from "./organization-gate-lanes-migration.ts";
import type { DeploySteps } from "./pipeline.ts";
import { type CommandRunner, type Environment, log, runCommand } from "./process.ts";
import type { VerifiedRelease } from "./release-bundle.ts";
import { activateSearchPlacements, cliSearchPlacementInvoker } from "./search-placements.ts";
import { loadDeploymentTarget, type DeploymentTarget } from "./target.ts";
import { createTerraformRoot, type TerraformRoot } from "./terraform.ts";
import { verifyHealth, verifyPublicSurface } from "./verify.ts";
import { verifyWorkerRollout } from "./worker-rollout.ts";

/** A loaded target with its account-scoped environment, command runner, and OpenTofu root. */
export interface Deployment {
  readonly environment: Environment;
  readonly run: CommandRunner;
  readonly target: DeploymentTarget;
  readonly terraform: TerraformRoot;
}

async function callerAccount(run: CommandRunner) {
  return (
    await run(["aws", "sts", "get-caller-identity", "--query", "Account", "--output", "text"])
  ).trim();
}

/** The deploying principal's ARN, recorded as the installation's `deployedBy` actor. */
async function callerArn(run: CommandRunner) {
  return (
    await run(["aws", "sts", "get-caller-identity", "--query", "Arn", "--output", "text"])
  ).trim();
}

/** Fails before any side effect when the caller's credentials belong to another account. */
export async function assertTargetAccount(deployment: Deployment) {
  const account = await callerAccount(deployment.run);
  if (account !== deployment.target.aws.accountId) {
    throw new Error(
      `Expected AWS account ${deployment.target.aws.accountId}, received ${account}.`,
    );
  }
}

/** Runs `task` with a private work directory that is removed afterwards (plans may hold secrets). */
export async function withDeployment<T>(
  targetPath: string,
  task: (deployment: Deployment) => Promise<T>,
): Promise<T> {
  const target = await loadDeploymentTarget(targetPath);
  const workDirectory = await mkdtemp(
    join(process.env.RUNNER_TEMP || tmpdir(), "platform-deploy-"),
  );
  await chmod(workDirectory, 0o700);
  const environment: Environment = {
    ...process.env,
    AWS_DEFAULT_REGION: target.aws.region,
    AWS_REGION: target.aws.region,
  };
  const run: CommandRunner = (command, options = {}) =>
    runCommand(command, { env: environment, ...options });
  try {
    return await task({
      environment,
      run,
      target,
      terraform: createTerraformRoot({
        directory: target.terraform.root,
        environment,
        run,
        target,
        workDirectory,
      }),
    });
  } finally {
    await rm(workDirectory, { force: true, recursive: true });
  }
}

/** Binds every pipeline step to the real AWS, container registry, and database adapters. */
export function deploySteps(deployment: Deployment, release: VerifiedRelease): DeploySteps {
  const { environment, run, target } = deployment;
  const region = target.aws.region;
  return {
    activateSearchPlacements: (functions) =>
      activateSearchPlacements({ functions, invoke: cliSearchPlacementInvoker(run) }),
    bootstrapAppDatabase: (outputs) => bootstrapAppDatabase({ outputs, region, run, runBootstrap }),
    bootstrapIdentity: (bootstrap, outputs) =>
      bootstrapIdentityClients({ bootstrap, name: target.name, outputs, region }),
    callerAccount: () => callerAccount(run),
    deployLambdas: (options) =>
      deployLambdaRelease({
        ...options,
        dryRun: false,
        name: target.name,
        now: Date.now,
        release,
        run,
      }),
    recheckGovernanceInventoryShards: async (outputs) => {
      await recheckGovernanceInventoryShards(dynamoPlatformTables(outputs, region));
    },
    migrateArtifactCreationIndex: async (outputs) => {
      await migrateArtifactCreationIndex(dynamoPlatformTables(outputs, region));
    },
    migrateMeterEventWorkspaces: async (outputs) => {
      await migrateMeterEventWorkspaces(dynamoPlatformTables(outputs, region));
    },
    migrateOrganizationLimits: async (outputs) => {
      await migrateOrganizationLimits(dynamoPlatformTables(outputs, region));
    },
    reconcileOrganizationGateLanes: async (outputs) => {
      if (outputs.dynamodb_table_names === undefined) {
        log("no dynamodb_table_names output yet; no organization has gate lanes to reconcile");
        return;
      }
      await reconcileOrganizationGateLanes(dynamoPlatformTables(outputs, region));
    },
    publishConsoleAssets: (bucket) =>
      publishConsoleAssets({ archivePath: release.assets.console.path, bucket, run }),
    publishImages: () =>
      publishImages({
        environment,
        names: target.profile.images,
        region,
        release,
        repositories: target.ecrRepositories,
        run,
      }),
    publishLambdaArtifacts: ({ bucket, kmsKeyArn }) =>
      publishLambdaArtifacts({ bucket, kmsKeyArn, release, run }),
    publishMicrovmImage: () =>
      publishMicrovmImage({ environment, region, variant: target.lambdaMicrovmImage }),
    readIdentityMarker: ssmIdentityMarkerReader(region),
    recordInstallation: async ({ images, lambdaFunctions, outputs }) =>
      recordInstallation(dynamoPlatformTables(outputs, region), {
        deployedBy: await callerArn(run),
        images,
        lambdaFunctions,
        outputs,
        release,
        target,
      }),
    sleepUntil: async (epochMilliseconds) => {
      const wait = epochMilliseconds - Date.now();
      if (wait <= 0) return;
      log(`waiting ${Math.ceil(wait / 1_000)} s for replaced code and cached reads to end`);
      await sleep(wait);
    },
    switchGovernanceInventoryShardWrites: (outputs) =>
      switchGovernanceInventoryShardWrites(dynamoPlatformTables(outputs, region)),
    syncModelRuntime: (outputs, prepareEmpty) =>
      syncModelRuntimeSecrets({ environment, outputs, prepareEmpty }),
    verifyConsole: (url) => verifyHealth(url),
    verifyMicrovm: (image) => verifyLambdaMicrovmRuntime({ ...image, region }),
    verifyPublicSurface: (endpoint, streamGatewayUrl) =>
      verifyPublicSurface({ endpoint, environment, run, streamGatewayUrl }),
    verifyWorkerRollout: (service) => verifyWorkerRollout({ run, service }),
  };
}
