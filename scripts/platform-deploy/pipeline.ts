import {
  GOVERNANCE_INVENTORY_LEGACY_WRITES_END_MILLISECONDS,
  type Installation,
} from "@deployments-ai/db";
import { consoleAssetsBucket } from "./console-assets.ts";
import type { DeployRun } from "./deploy-events.ts";
import type { DeployStageRunner } from "./deploy-stages.ts";
import { identityBootstrap, type IdentityBootstrap } from "./identity-clients.ts";
import { identityDomainState, type IdentityMarkerReader } from "./identity-domain.ts";
import {
  type LambdaRelease,
  lambdaReleaseOptions,
  type LambdaReleaseOptions,
  type ReleasedLambdaFunction,
} from "./lambda-release.ts";
import { currentMicrovmImageVariables, type MicrovmImageVariables } from "./microvm.ts";
import { log } from "./process.ts";
import {
  type PlatformImage,
  platformImages,
  platformStackModule,
  type PlatformImageName,
  rootProfiles,
} from "./profiles.ts";
import type { VerifiedRelease } from "./release-bundle.ts";
import { searchPlacementFunctions } from "./search-placements.ts";
import type { DeploymentTarget } from "./target.ts";
import type { TerraformOutputs, TerraformRoot } from "./terraform.ts";
import { consoleEndpoint, platformEndpoint, streamGatewayEndpoint } from "./verify.ts";
import { agentWorkerService, type WorkerService } from "./worker-rollout.ts";

const artifactStoreAddresses = [
  "ownership_controls",
  "public_access_block",
  "policy",
  "server_side_encryption_configuration",
  "versioning",
  "cors_configuration",
  "lifecycle_configuration",
].map(
  (resource) => `${platformStackModule}.module.platform_data.aws_s3_bucket_${resource}.artifacts`,
);
const artifactVersioningAddress = `${platformStackModule}.module.platform_data.aws_s3_bucket_versioning.artifacts`;
const artifactStoreOutputs = ["artifact_bucket_name", "data_kms_key_arn"] as const;

const modelRuntimeModule = `${platformStackModule}.module.model_runtime[0]`;
const sandboxRuntimeModule = `${platformStackModule}.module.sandbox_runtime[0]`;

export const targetVariables = ["aws_account_id", "aws_region"] as const;

/** Side-effecting deployment steps outside OpenTofu, injected so ordering is testable. */
export interface DeploySteps {
  /** Activates default memory and Brain search for every organization still unconfigured. */
  activateSearchPlacements(functionNames: readonly string[]): Promise<void>;
  bootstrapAppDatabase(outputs: TerraformOutputs): Promise<void>;
  bootstrapIdentity(bootstrap: IdentityBootstrap, outputs: TerraformOutputs): Promise<void>;
  callerAccount(): Promise<string>;
  deployLambdas(options: LambdaReleaseOptions): Promise<LambdaRelease>;
  /** Folds legacy organization limit overrides into operator grants and deletes them, once. */
  migrateOrganizationLimits(outputs: TerraformOutputs): Promise<void>;
  /** Names the run's workspace on every meter event stored before meter events did, once. */
  migrateMeterEventWorkspaces(outputs: TerraformOutputs): Promise<void>;
  /** Moves every artifact stored before the creation-ordered environment index onto it, once. */
  migrateArtifactCreationIndex(outputs: TerraformOutputs): Promise<void>;
  /**
   * Re-checks every organization's governance inventory shard locators once after shard writes turned
   * on. Legacy locators stay where they are; an operator moves them with
   * `scripts/governance-inventory-migration.ts`.
   */
  recheckGovernanceInventoryShards(outputs: TerraformOutputs): Promise<void>;
  /**
   * Creates or repairs every organization's gate lanes from its gate sources. Released code refuses
   * tenant writes for an organization without lanes, and older code changes gate sources without
   * moving lanes, so it runs once before any released code, once after all of it is live, and once
   * after the last invocation of replaced Lambda code has ended.
   */
  reconcileOrganizationGateLanes(outputs: TerraformOutputs): Promise<void>;
  publishImages(): Promise<Readonly<Partial<Record<PlatformImageName, string>>>>;
  publishLambdaArtifacts(input: {
    readonly bucket: string;
    readonly kmsKeyArn: string;
  }): Promise<Readonly<Record<string, unknown>>>;
  /** Uploads the release's console static assets; runs before the console Lambda code changes. */
  publishConsoleAssets(bucket: string): Promise<void>;
  publishMicrovmImage(): Promise<MicrovmImageVariables>;
  readIdentityMarker: IdentityMarkerReader;
  /** Writes the installation record; runs only after every verification step succeeded. */
  recordInstallation(input: {
    readonly images: Readonly<Partial<Record<PlatformImageName, string>>>;
    readonly lambdaFunctions: readonly ReleasedLambdaFunction[];
    readonly outputs: TerraformOutputs;
  }): Promise<Installation>;
  /** Resolves once the clock reaches `epochMilliseconds`. */
  sleepUntil(epochMilliseconds: number): Promise<void>;
  /** Turns shard writes on for governance inventory locators; resolves to when they turned on. */
  switchGovernanceInventoryShardWrites(outputs: TerraformOutputs): Promise<number>;
  syncModelRuntime(outputs: TerraformOutputs, prepareEmpty: boolean): Promise<void>;
  verifyMicrovm(image: MicrovmImageVariables): Promise<void>;
  verifyConsole(url: string): Promise<void>;
  verifyPublicSurface(endpoint: string, streamGatewayUrl: string | undefined): Promise<void>;
  verifyWorkerRollout(service: WorkerService): Promise<void>;
}

export interface DeployResult {
  readonly endpoint: string | null;
  readonly images: Readonly<Partial<Record<PlatformImageName, string>>>;
  readonly name: string;
  readonly sourceCommit: string;
}

function nonEmptyObject(value: unknown) {
  return value !== null && typeof value === "object" && Object.keys(value).length > 0;
}

function requiredOutputText(outputs: TerraformOutputs, name: string) {
  const value = outputs[name];
  if (typeof value !== "string" || !value) throw new Error(`OpenTofu output ${name} is empty.`);
  return value;
}

interface DeployPipelineInput {
  readonly release: Pick<VerifiedRelease, "images" | "manifestSha256" | "sourceCommit">;
  readonly steps: DeploySteps;
  readonly target: DeploymentTarget;
  readonly terraform: TerraformRoot;
}

interface StagedDeployment {
  readonly installation: Installation;
  readonly result: DeployResult;
}

export async function runDeployPipeline(
  input: DeployPipelineInput & { readonly run: DeployRun },
): Promise<DeployResult> {
  const { release, run, target } = input;
  run.start({
    releaseManifestSha256: release.manifestSha256,
    sourceCommit: release.sourceCommit,
    target: target.name,
  });
  let deployed: StagedDeployment;
  try {
    deployed = await runStages(input, run.runStage);
  } catch (error) {
    run.failOnce(error);
    throw error;
  }
  run.succeed(deployed.installation);
  return deployed.result;
}

async function runStages(
  input: DeployPipelineInput,
  stage: DeployStageRunner,
): Promise<StagedDeployment> {
  const { release, steps, target, terraform } = input;
  const { profile } = target;

  await stage("callerAccount", async () => {
    const account = await steps.callerAccount();
    if (account !== target.aws.accountId) {
      throw new Error(`Expected AWS account ${target.aws.accountId}, received ${account}.`);
    }
  });
  const initial = await stage("init", async () => {
    await terraform.init();
    return { outputs: await terraform.outputs(), resources: await terraform.stateResources() };
  });

  const variables: Record<string, unknown> = {
    aws_account_id: target.aws.accountId,
    aws_region: target.aws.region,
  } satisfies Record<(typeof targetVariables)[number], string>;

  // Versioning is the last artifact-store resource a fresh account needs before publication.
  // The store is also applied when state lacks an output publication reads (for example a
  // renamed store output), because `terraform output` only reports applied state.
  const storeOutputs =
    !initial.resources.includes(artifactVersioningAddress) ||
    artifactStoreOutputs.some((name) => !initial.outputs[name])
      ? await stage("apply:artifact-store", async () => {
          await terraform.apply({
            label: "artifact-store",
            targets: artifactStoreAddresses,
            variables,
          });
          return await terraform.outputs();
        })
      : initial.outputs;

  const images = await stage("publishImages", async () => {
    const published = await steps.publishImages();
    for (const name of profile.images) {
      const uri = published[name];
      if (!uri) throw new Error(`Image publication returned no ${name} URI.`);
      const definition: PlatformImage = platformImages[name];
      variables[definition.terraformVariable] = uri;
      if (definition.deploymentMetadata) {
        const document = release.images[name]?.deploymentMetadata;
        if (document === undefined) {
          throw new Error(`Release has no ${definition.deploymentMetadata.file} for ${name}.`);
        }
        variables[definition.deploymentMetadata.terraformVariable] = document;
      }
    }
    return published;
  });

  let microvmImage: MicrovmImageVariables | undefined;
  if (profile.lambdaMicrovm) {
    await stage("apply:lambda-microvm-prerequisites", async () => {
      Object.assign(variables, currentMicrovmImageVariables(storeOutputs) ?? {});
      await terraform.apply({
        label: "lambda-microvm-prerequisites",
        targets: [sandboxRuntimeModule],
        variables,
      });
    });
    microvmImage = await stage("publishMicrovmImage", () => steps.publishMicrovmImage());
    Object.assign(variables, microvmImage);
  } else if (rootProfiles[target.profileName].lambdaMicrovm) {
    // The target turned the profile's MicroVM steps off, so the root must not create the sandbox.
    variables.sandbox_lambda_microvm_enabled = false;
  }

  await stage("publishLambdaArtifacts", async () => {
    const artifactStore = {
      bucket: requiredOutputText(storeOutputs, "artifact_bucket_name"),
      kmsKeyArn: requiredOutputText(storeOutputs, "data_kms_key_arn"),
    };
    Object.assign(variables, await steps.publishLambdaArtifacts(artifactStore));
  });

  // Targeting the region data source refreshes model_runtime_hosted_providers for the seed sync.
  await stage("apply:model-runtime-secrets", () =>
    terraform.apply({
      label: "model-runtime-secrets",
      targets: [
        `${modelRuntimeModule}.aws_ssm_parameter.runtime`,
        `${modelRuntimeModule}.data.aws_region.current`,
      ],
      variables,
    }),
  );
  await stage("syncModelRuntime:prepare", async () =>
    steps.syncModelRuntime(await terraform.outputs(), true),
  );

  await stage("reconcileOrganizationGateLanes:prepare", () =>
    steps.reconcileOrganizationGateLanes(initial.outputs),
  );
  const deployed = await stage("apply:deployment", async () => {
    const { publishDomain } = await identityDomainState({
      outputs: await terraform.outputs(),
      readMarker: steps.readIdentityMarker,
      stateResources: await terraform.stateResources(),
    });
    variables.platform_identity_publish_domain = publishDomain;
    await terraform.apply({ label: "deployment", variables });
    const outputs = await terraform.outputs();
    return {
      bootstrap: identityBootstrap(outputs),
      outputs,
      publishDomain,
      workerService: agentWorkerService(outputs),
    };
  });
  const { bootstrap, outputs, workerService } = deployed;
  if (microvmImage) await stage("verifyMicrovm", () => steps.verifyMicrovm(microvmImage));
  // OpenTofu does not wait for ECS: a circuit-breaker rollback also reaches a
  // steady state, so only the rollout's task definition proves the release.
  if (workerService) {
    await stage("verifyWorkerRollout", () => steps.verifyWorkerRollout(workerService));
  }
  if (nonEmptyObject(outputs.model_runtime_secret_arns)) {
    await stage("syncModelRuntime:full", () => steps.syncModelRuntime(outputs, false));
  }
  if (outputs.app_runtime !== null && typeof outputs.app_runtime === "object") {
    await stage("bootstrapAppDatabase", () => steps.bootstrapAppDatabase(outputs));
  }
  if (bootstrap)
    await stage("bootstrapIdentity", () => steps.bootstrapIdentity(bootstrap, outputs));
  // New server code renders pages that reference the new hashed assets, so they upload first.
  const assetsBucket = consoleAssetsBucket(outputs);
  if (assetsBucket) {
    await stage("publishConsoleAssets", () => steps.publishConsoleAssets(assetsBucket));
  }
  const lambdaRelease = await stage("deployLambdas", () =>
    steps.deployLambdas(lambdaReleaseOptions(outputs, profile.allowMissingLambdas)),
  );
  await stage("reconcileOrganizationGateLanes:repair", () =>
    steps.reconcileOrganizationGateLanes(outputs),
  );
  // No released code reads or writes the legacy items any more, so deleting them strands nothing.
  await stage("migrateOrganizationLimits", () => steps.migrateOrganizationLimits(outputs));
  // Runs on the released Lambda code, so the functions exist and understand the request.
  const placementFunctions = searchPlacementFunctions(outputs);
  if (placementFunctions.length > 0) {
    await stage("activateSearchPlacements", () =>
      steps.activateSearchPlacements(placementFunctions),
    );
  }

  const publishedOutputs =
    !deployed.publishDomain && bootstrap?.publicationReady
      ? await stage("apply:identity-domain", async () => {
          variables.platform_identity_publish_domain = true;
          await terraform.apply({ label: "identity-domain", variables });
          return await terraform.outputs();
        })
      : outputs;

  const endpoint = platformEndpoint(publishedOutputs);
  if (endpoint) {
    await stage("verifyPublicSurface", () =>
      steps.verifyPublicSurface(endpoint, streamGatewayEndpoint(publishedOutputs)),
    );
  } else {
    log("no platform_api_endpoint output; skipping public verification");
  }
  const consoleUrl = consoleEndpoint(publishedOutputs);
  if (consoleUrl) await stage("verifyConsole", () => steps.verifyConsole(consoleUrl));
  // Replaced Lambda code still running after the repair can change gate sources without moving
  // lanes, and can create organizations the repair never listed.
  await stage("reconcileOrganizationGateLanes:final", async () => {
    await steps.sleepUntil(lambdaRelease.replacedCodeEndsAt);
    await steps.reconcileOrganizationGateLanes(publishedOutputs);
  });
  // Replaced code lists only the legacy inventory partition, so shard writes turn on once it has
  // ended, and shard locators are re-checked once every process has seen the switch.
  await stage("migrateGovernanceInventoryShards", async () => {
    await steps.sleepUntil(lambdaRelease.replacedCodeEndsAt);
    const shardWritesSince = await steps.switchGovernanceInventoryShardWrites(publishedOutputs);
    await steps.sleepUntil(shardWritesSince + GOVERNANCE_INVENTORY_LEGACY_WRITES_END_MILLISECONDS);
    await steps.recheckGovernanceInventoryShards(publishedOutputs);
  });
  // Replaced code writes a run's meter events without their workspace, so the events are attributed
  // once its last invocation has ended and no unattributed event can follow.
  await stage("migrateMeterEventWorkspaces", async () => {
    await steps.sleepUntil(lambdaRelease.replacedCodeEndsAt);
    await steps.migrateMeterEventWorkspaces(publishedOutputs);
  });
  // Replaced code writes artifacts with the status-ordered environment key, so they are re-keyed
  // once its last invocation has ended.
  await stage("migrateArtifactCreationIndex", async () => {
    await steps.sleepUntil(lambdaRelease.replacedCodeEndsAt);
    await steps.migrateArtifactCreationIndex(publishedOutputs);
  });
  const releasedImages = Object.fromEntries(profile.images.map((name) => [name, images[name]]));
  const installation = await stage("recordInstallation", () =>
    steps.recordInstallation({
      images: releasedImages,
      lambdaFunctions: lambdaRelease.functions,
      outputs: publishedOutputs,
    }),
  );
  return {
    installation,
    result: {
      endpoint: endpoint ?? null,
      images: releasedImages,
      name: target.name,
      sourceCommit: input.release.sourceCommit,
    },
  };
}
