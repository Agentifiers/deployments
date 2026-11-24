import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { makeDynamoDatabase, makeIdentityRepository, makeIdGenerator } from "@deployments-ai/db";
import { consoleBuildFromEnvironment } from "./build-deployment-artifacts.ts";
import { bootstrapAdministrator } from "./platform-deploy/admin-bootstrap.ts";
import {
  type CliCommand,
  isRegistryCommand,
  parseCli,
  type RegistryCommand,
  usage,
} from "./platform-deploy/cli.ts";
import { deployEventFile, deployRun } from "./platform-deploy/deploy-events.ts";
import {
  assertTargetAccount,
  type Deployment,
  deploySteps,
  withDeployment,
} from "./platform-deploy/deployment.ts";
import { consoleAssetsBucket, publishConsoleAssets } from "./platform-deploy/console-assets.ts";
import { bootstrapIdentityClients, identityBootstrap } from "./platform-deploy/identity-clients.ts";
import { deployLambdaRelease, lambdaReleaseOptions } from "./platform-deploy/lambda-release.ts";
import { dynamoPlatformTables } from "./platform-deploy/installation-record.ts";
import { syncModelRuntimeSecrets } from "./platform-deploy/model-runtime-secrets.ts";
import { runDeployPipeline } from "./platform-deploy/pipeline.ts";
import { log, runCommand, runMain } from "./platform-deploy/process.ts";
import { verifyReleaseBundle } from "./platform-deploy/release-bundle.ts";
import { runRegistryCommand } from "./platform-deploy/release-registry/commands.ts";
import { buildRelease } from "./platform-deploy/release-build.ts";
import { shareAmi } from "./platform-deploy/share-ami.ts";
import { assertSourcePairing } from "./platform-deploy/source-pairing.ts";
import {
  consoleEndpoint,
  platformEndpoint,
  streamGatewayEndpoint,
  verifyHealth,
  verifyPublicSurface,
} from "./platform-deploy/verify.ts";

/** Operator commands verify the account and read the applied root's outputs first. */
async function appliedOutputs(deployment: Deployment) {
  await assertTargetAccount(deployment);
  await deployment.terraform.init();
  return await deployment.terraform.outputs();
}

async function deploy(command: Extract<CliCommand, { kind: "deploy" }>) {
  const report = deployRun(command.events ? deployEventFile(resolve(command.events)) : () => {});
  try {
    const result = await withDeployment(command.target, async (deployment) => {
      const release = await verifyReleaseBundle(command.bundle, deployment.target.profile.images, {
        signingPublicKeyPath: deployment.environment.RELEASE_SIGNING_PUBLIC_KEY || undefined,
      });
      await assertSourcePairing({ releaseCommit: release.sourceCommit });
      return await runDeployPipeline({
        release,
        run: report,
        steps: deploySteps(deployment, release),
        target: deployment.target,
        terraform: deployment.terraform,
      });
    });
    if (command.result) {
      await writeFile(resolve(command.result), `${JSON.stringify(result, null, 2)}\n`);
    }
    log(`deployed ${result.sourceCommit} to ${result.name}`);
  } catch (error) {
    report.failOnce(error);
    throw error;
  }
}

async function execute(
  command: Exclude<
    CliCommand,
    { kind: "deploy" | "help" | "release-build" | "release-share-ami" } | RegistryCommand
  >,
) {
  await withDeployment(command.target, async (deployment) => {
    const { environment, run, target } = deployment;
    const region = target.aws.region;
    const signingPublicKeyPath = environment.RELEASE_SIGNING_PUBLIC_KEY || undefined;
    switch (command.kind) {
      case "secrets-sync": {
        const outputs = await appliedOutputs(deployment);
        await syncModelRuntimeSecrets({
          environment,
          outputs,
          prepareEmpty: command.prepareEmpty,
        });
        return;
      }
      case "identity-bootstrap": {
        const outputs = await appliedOutputs(deployment);
        const bootstrap = identityBootstrap(outputs);
        if (!bootstrap) throw new Error("OpenTofu output platform_identity_bootstrap is empty.");
        await bootstrapIdentityClients({ bootstrap, name: target.name, outputs, region });
        return;
      }
      case "admin-bootstrap": {
        const outputs = await appliedOutputs(deployment);
        const { client, tableNames } = dynamoPlatformTables(outputs, region);
        if (!tableNames.identity) {
          throw new Error("OpenTofu output dynamodb_table_names does not name the identity table.");
        }
        const ids = makeIdGenerator();
        const { outcome, principalId } = await bootstrapAdministrator({
          email: command.email,
          generateId: () => ids.generate(),
          now: new Date(),
          repository: makeIdentityRepository(makeDynamoDatabase(client, tableNames)),
        });
        log(`${outcome} platform administrator ${command.email} (${principalId})`);
        if (outcome === "created") {
          const issuer = outputs.platform_identity_issuer;
          const signIn =
            typeof issuer === "string" && issuer
              ? `${issuer}/sign-in`
              : "the identity sign-in page once the identity domain is published";
          log(`they choose a password with "Forgot password?" at ${signIn}`);
        }
        return;
      }
      case "lambdas-deploy": {
        const release = await verifyReleaseBundle(command.bundle, [], { signingPublicKeyPath });
        await assertSourcePairing({ releaseCommit: release.sourceCommit });
        const outputs = await appliedOutputs(deployment);
        const assetsBucket = consoleAssetsBucket(outputs);
        if (assetsBucket && !command.dryRun) {
          await publishConsoleAssets({
            archivePath: release.assets.console.path,
            bucket: assetsBucket,
            run,
          });
        }
        await deployLambdaRelease({
          ...lambdaReleaseOptions(outputs, target.profile.allowMissingLambdas),
          dryRun: command.dryRun,
          name: target.name,
          now: Date.now,
          release,
          run,
        });
        return;
      }
      case "verify": {
        const outputs = await appliedOutputs(deployment);
        const endpoint = platformEndpoint(outputs);
        if (!endpoint) throw new Error("OpenTofu output platform_api_endpoint is empty.");
        await verifyPublicSurface({
          endpoint,
          environment,
          run,
          streamGatewayUrl: streamGatewayEndpoint(outputs),
        });
        const consoleUrl = consoleEndpoint(outputs);
        if (consoleUrl) await verifyHealth(consoleUrl);
        return;
      }
    }
  });
}

async function main() {
  const command = parseCli(process.argv.slice(2));
  if (command.kind === "help") {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (command.kind === "release-build") {
    await buildRelease({
      bundle: command.bundle,
      consoleBuild: await consoleBuildFromEnvironment(process.env),
      run: runCommand,
    });
    return;
  }
  if (command.kind === "release-share-ami") {
    const { keys, snapshots } = await shareAmi({ ...command, run: runCommand });
    process.stdout.write(
      `shared ${command.ami} with ${command.account}: ${snapshots.length} snapshots, ${keys.length} KMS grants\n`,
    );
    return;
  }
  if (isRegistryCommand(command)) {
    await runRegistryCommand(command, process.env);
    return;
  }
  if (command.kind === "deploy") {
    await deploy(command);
    return;
  }
  await execute(command);
}

if (import.meta.main) runMain(main);
