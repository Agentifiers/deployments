import { PublicId } from "@deployments-ai/api-contract";
import {
  DEFAULT_TABLE_NAMES,
  type Installation,
  makeDynamoDatabase,
  makeInstallationRepository,
  Ulid,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { type DeployEventBody, deployRun } from "./deploy-events.ts";
import { deployStages, type DeployStageId } from "./deploy-stages.ts";
import { recordInstallation } from "./installation-record.ts";
import { type DeploySteps, runDeployPipeline } from "./pipeline.ts";
import { rootProfiles, type RootProfileName } from "./profiles.ts";
import type { VerifiedRelease } from "./release-bundle.ts";
import type { DeploymentTarget } from "./target.ts";
import type { TerraformApply, TerraformOutputs, TerraformRoot } from "./terraform.ts";
import { platformEndpoint } from "./verify.ts";

const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const manifestSha256 = "5".repeat(64);
const webSecretArn = "arn:aws:ssm:us-east-2:123456789012:parameter/identity/web-oauth-client";
const recordedAt = "2026-10-09T04:02:10.000Z";
const installation: Installation = {
  awsAccountId: "123456789012",
  awsRegion: "us-east-2",
  createdAt: "2026-10-01T00:00:00.000Z",
  deployedAt: recordedAt,
  deployedBy: "arn:aws:sts::123456789012:assumed-role/deployer/ci",
  deploymentId: Schema.decodeUnknownSync(Ulid)("01K7ABCDEFGHJKMNPQRSTVWXYZ"),
  endpoints: [{ name: "platform-api", url: "https://api.example.com" }],
  id: "current",
  images: [],
  lambdaArtifacts: [],
  profile: "platform-dev",
  releaseManifestSha256: manifestSha256,
  sourceCommit,
  targetName: "acme",
  updatedAt: recordedAt,
  version: 2,
};

const ran = (...stages: DeployStageId[]): DeployEventBody[] =>
  stages.flatMap((stage) => [
    { stage, type: "stage-started" },
    { stage, type: "stage-succeeded" },
  ]);
const started: DeployEventBody = {
  releaseManifestSha256: manifestSha256,
  sourceCommit,
  target: "acme",
  type: "started",
};
const recorded: DeployEventBody = {
  installation: {
    awsAccountId: "123456789012",
    awsRegion: "us-east-2",
    deployedAt: recordedAt,
    deployedBy: "arn:aws:sts::123456789012:assumed-role/deployer/ci",
    deploymentId: Schema.decodeUnknownSync(PublicId)("01K7ABCDEFGHJKMNPQRSTVWXYZ"),
    endpoints: [{ name: "platform-api", url: "https://api.example.com" }],
    images: [],
    lambdaArtifacts: [],
    profile: "platform-dev",
    releaseManifestSha256: manifestSha256,
    sourceCommit,
    targetName: "acme",
    updatedAt: recordedAt,
    version: 2,
  },
  type: "recorded",
};

function target(profile: RootProfileName, lambdaMicrovm?: boolean): DeploymentTarget {
  return {
    aws: { accountId: "123456789012", region: "us-east-2" },
    ecrRepositories: {
      "agent-worker": "agent-worker",
      "app-gateway": "app-gateway",
      bifrost: "bifrost",
      "durable-streams": "durable-streams",
      firecrawl: "firecrawl",
      "model-gateway": "model-gateway",
      "observability-hot-plane": "observability-hot-plane",
      "stream-gateway": "stream-gateway",
      "web-tools-proxy": "web-tools-proxy",
    },
    lambdaMicrovmImage: "sandbox",
    name: "acme",
    profile: {
      ...rootProfiles[profile],
      lambdaMicrovm: lambdaMicrovm ?? rootProfiles[profile].lambdaMicrovm,
    },
    profileName: profile,
    terraform: {
      root: "/srv/acme/root",
      stateBucket: "state",
      stateKey: "platform/acme/terraform.tfstate",
      varFiles: [],
    },
  };
}

const bootstrap = (publicationReady: boolean) => ({
  bootstrap_role_arn: "arn:aws:iam::123456789012:role/identity-bootstrap",
  cli_redirect_uris: ["http://127.0.0.1/callback"],
  completion_marker_name: "/identity/bootstrap-complete",
  publication_ready: publicationReady,
  web_client_secret_arn: webSecretArn,
  web_redirect_uris: ["https://app.example.com/callback"],
});

const appRuntime = {
  cluster_arn: "arn:aws:rds:us-east-2:123456789012:cluster:apps",
  database_function_name: "apps-database",
  master_user_secret_arn: "arn:aws:secretsmanager:us-east-2:123456789012:secret:rds!cluster-apps",
  oauth_client: {
    client_id: "deployments-apps",
    redirect_uri: "https://apps.example.com/_platform/auth/callback",
    secret_arn: "arn:aws:ssm:us-east-2:123456789012:parameter/identity/apps-dev-oauth-client",
  },
};

const firecrawlTable = {
  attributes: [{ name: "pk", type: "S" }],
  billing_mode: "PAY_PER_REQUEST",
  global_secondary_indexes: [],
  hash_key: "pk",
  ttl_attribute: "ttl",
  version: 1,
};
const releaseImages: VerifiedRelease["images"] = {
  firecrawl: {
    deploymentMetadata: firecrawlTable,
    digest: `sha256:${"7".repeat(64)}`,
    file: "images/firecrawl.oci.tar",
    path: "/bundle/images/firecrawl.oci.tar",
    platform: "linux/arm64",
    sha256: "7".repeat(64),
  },
};

interface Scenario {
  readonly account?: string;
  readonly after: TerraformOutputs;
  readonly before?: TerraformOutputs;
  readonly lambdaMicrovm?: boolean;
  readonly reported?: DeployEventBody[];
  readonly releaseImages?: VerifiedRelease["images"];
  readonly marker?: string;
  readonly profile: RootProfileName;
  readonly recordInstallation?: DeploySteps["recordInstallation"];
  readonly state: readonly string[];
  readonly stepCalls?: string[];
  /** Artifact-store outputs already in state; the store apply writes the current ones. */
  readonly storeBefore?: TerraformOutputs;
  readonly verifyFails?: boolean;
}

async function deploy(scenario: Scenario) {
  const stepCalls: string[] = scenario.stepCalls ?? [];
  const applies: TerraformApply[] = [];
  let state = [...scenario.state];
  const store = { artifact_bucket_name: "artifacts", data_kms_key_arn: "arn:kms" };
  const terraform: TerraformRoot = {
    apply: async (input) => {
      stepCalls.push(`apply:${input.label}`);
      applies.push({ ...input, variables: { ...input.variables } });
      if (input.label === "artifact-store") {
        state = [
          ...state,
          "module.platform.module.platform_data.aws_s3_bucket_versioning.artifacts",
        ];
      }
    },
    init: async () => {
      stepCalls.push("init");
    },
    outputs: async () => {
      const storeOutputs = stepCalls.includes("apply:artifact-store")
        ? store
        : (scenario.storeBefore ?? store);
      return stepCalls.includes("apply:deployment")
        ? { ...storeOutputs, ...scenario.after }
        : { ...storeOutputs, ...scenario.before };
    },
    stateResources: async () => state,
  };
  const record =
    (name: string) =>
    async (..._arguments: unknown[]) => {
      stepCalls.push(name);
    };
  const steps: DeploySteps = {
    activateSearchPlacements: async (functions) => {
      stepCalls.push(`activateSearchPlacements:${functions.join(",")}`);
    },
    bootstrapAppDatabase: record("bootstrapAppDatabase"),
    bootstrapIdentity: record("bootstrapIdentity"),
    callerAccount: async () => {
      stepCalls.push("callerAccount");
      return scenario.account ?? "123456789012";
    },
    deployLambdas: async (options) => {
      stepCalls.push(`deployLambdas:${options.allowMissing}`);
      return {
        functions: [{ artifact: "platform-api", codeSha256: "a".repeat(64), functionName: "api" }],
        replacedCodeEndsAt: 1_798_761_600_000,
      };
    },
    migrateArtifactCreationIndex: record("migrateArtifactCreationIndex"),
    migrateMeterEventWorkspaces: record("migrateMeterEventWorkspaces"),
    migrateOrganizationLimits: record("migrateOrganizationLimits"),
    recheckGovernanceInventoryShards: record("recheckGovernanceInventoryShards"),
    reconcileOrganizationGateLanes: async (outputs) => {
      stepCalls.push(
        `reconcileOrganizationGateLanes:${stepCalls.includes("apply:deployment") ? "released" : "previous"}:${Object.keys(outputs).length}`,
      );
    },
    publishImages: async () => {
      stepCalls.push("publishImages");
      return {
        "agent-worker": "ecr/agent-worker@sha256:4",
        "app-gateway": "ecr/app-gateway@sha256:8",
        bifrost: "ecr/bifrost@sha256:9",
        "durable-streams": "ecr/durable-streams@sha256:1",
        firecrawl: "ecr/firecrawl@sha256:7",
        "model-gateway": "ecr/model-gateway@sha256:6",
        "observability-hot-plane": "ecr/observability-hot-plane@sha256:2",
        "stream-gateway": "ecr/stream-gateway@sha256:5",
        "web-tools-proxy": "ecr/web-tools-proxy@sha256:3",
      };
    },
    publishConsoleAssets: async (bucket) => {
      stepCalls.push(`publishConsoleAssets:${bucket}`);
    },
    publishLambdaArtifacts: async () => {
      stepCalls.push("publishLambdaArtifacts");
      return { platform_api_artifact_key: "releases/sha256/x/platform-api.zip" };
    },
    publishMicrovmImage: async () => {
      stepCalls.push("publishMicrovmImage");
      return { lambda_microvm_image_identifier: "arn:image", lambda_microvm_image_version: "2" };
    },
    readIdentityMarker: async () => {
      stepCalls.push("readIdentityMarker");
      return scenario.marker;
    },
    recordInstallation:
      scenario.recordInstallation ??
      (async ({ images, lambdaFunctions, outputs }) => {
        stepCalls.push(
          `recordInstallation:${Object.keys(images).length}:${lambdaFunctions.map((released) => released.functionName).join(",")}:${platformEndpoint(outputs) ?? ""}`,
        );
        return installation;
      }),
    sleepUntil: async (epochMilliseconds) => {
      stepCalls.push(`sleepUntil:${epochMilliseconds}`);
    },
    switchGovernanceInventoryShardWrites: async () => {
      stepCalls.push("switchGovernanceInventoryShardWrites");
      return 1_798_761_700_000;
    },
    syncModelRuntime: async (_outputs, prepareEmpty) => {
      stepCalls.push(prepareEmpty ? "syncModelRuntime:prepare" : "syncModelRuntime:full");
    },
    verifyConsole: async (url) => {
      stepCalls.push(`verifyConsole:${url}`);
    },
    verifyMicrovm: record("verifyMicrovm"),
    verifyPublicSurface: async (endpoint) => {
      stepCalls.push(`verifyPublicSurface:${endpoint}`);
      if (scenario.verifyFails) throw new Error("public surface is unhealthy");
    },
    verifyWorkerRollout: async (service) => {
      stepCalls.push(`verifyWorkerRollout:${service.serviceName}:${service.taskDefinitionArn}`);
    },
  };
  const reported = scenario.reported ?? [];
  const result = await runDeployPipeline({
    release: { images: scenario.releaseImages ?? releaseImages, manifestSha256, sourceCommit },
    run: deployRun((event) => reported.push(event)),
    steps,
    target: target(scenario.profile, scenario.lambdaMicrovm),
    terraform,
  });
  return { applies, reported, result, stepCalls };
}

const freshCustomerOutputs: TerraformOutputs = {
  agent_runtime_worker: {
    cluster_arn: "arn:aws:ecs:us-east-2:123456789012:cluster/models-cluster",
    service_name: "agent-worker",
    task_definition_arn: "arn:aws:ecs:us-east-2:123456789012:task-definition/agent-worker:7",
  },
  console_assets_bucket: "console-assets-123456789012",
  console_url: "https://app.example.com",
  model_runtime_secret_arns: { "model-grants-json": "arn:ssm" },
  platform_api_endpoint: "https://api.example.com",
  platform_identity_bootstrap: bootstrap(true),
};

describe("platform deploy pipeline", () => {
  test("runs the customer profile's MicroVM steps unless the target turns them off", async () => {
    const enabled = await deploy({
      after: freshCustomerOutputs,
      profile: "platform-customer",
      state: [],
    });
    expect(enabled.stepCalls).toContain("publishMicrovmImage");
    expect(enabled.stepCalls).toContain("verifyMicrovm");
    expect(enabled.stepCalls.some((call) => call.startsWith("activateSearchPlacements"))).toBe(
      false,
    );

    const disabled = await deploy({
      after: freshCustomerOutputs,
      lambdaMicrovm: false,
      profile: "platform-customer",
      state: [],
    });
    expect(disabled.stepCalls).not.toContain("apply:lambda-microvm-prerequisites");
    expect(disabled.stepCalls).not.toContain("publishMicrovmImage");
    expect(disabled.stepCalls).not.toContain("verifyMicrovm");
    const deployment = disabled.applies.find((apply) => apply.label === "deployment");
    expect(deployment?.variables.sandbox_lambda_microvm_enabled).toBe(false);
    expect(deployment?.variables.lambda_microvm_image_identifier).toBeUndefined();
  });

  test("bootstraps a fresh dev-shaped account in contract order", async () => {
    const { applies, reported, result, stepCalls } = await deploy({
      after: {
        agent_runtime_worker: {
          cluster_arn: "arn:aws:ecs:us-east-2:123456789012:cluster/models-cluster",
          service_name: "agent-worker",
          task_definition_arn: "arn:aws:ecs:us-east-2:123456789012:task-definition/agent-worker:7",
        },
        app_runtime: appRuntime,
        console_assets_bucket: "console-assets-123456789012",
        console_url: "https://app.example.com",
        model_runtime_secret_arns: { "model-grants-json": "arn:ssm" },
        platform_api_endpoint: "https://api.example.com",
        platform_identity_bootstrap: bootstrap(true),
        search_placement_functions: { brain: "brain-search-placement", memory: null },
      },
      profile: "platform-dev",
      state: [],
    });

    expect(stepCalls).toEqual([
      "callerAccount",
      "init",
      "apply:artifact-store",
      "publishImages",
      "apply:lambda-microvm-prerequisites",
      "publishMicrovmImage",
      "publishLambdaArtifacts",
      "apply:model-runtime-secrets",
      "syncModelRuntime:prepare",
      "reconcileOrganizationGateLanes:previous:2",
      "apply:deployment",
      "verifyMicrovm",
      "verifyWorkerRollout:agent-worker:arn:aws:ecs:us-east-2:123456789012:task-definition/agent-worker:7",
      "syncModelRuntime:full",
      "bootstrapAppDatabase",
      "bootstrapIdentity",
      "publishConsoleAssets:console-assets-123456789012",
      "deployLambdas:false",
      "reconcileOrganizationGateLanes:released:10",
      "migrateOrganizationLimits",
      "activateSearchPlacements:brain-search-placement",
      "apply:identity-domain",
      "verifyPublicSurface:https://api.example.com",
      "verifyConsole:https://app.example.com",
      "sleepUntil:1798761600000",
      "reconcileOrganizationGateLanes:released:10",
      "sleepUntil:1798761600000",
      "switchGovernanceInventoryShardWrites",
      "sleepUntil:1798761760000",
      "recheckGovernanceInventoryShards",
      "sleepUntil:1798761600000",
      "migrateMeterEventWorkspaces",
      "sleepUntil:1798761600000",
      "migrateArtifactCreationIndex",
      "recordInstallation:9:api:https://api.example.com",
    ]);
    expect(reported).toEqual([
      started,
      ...ran(...deployStages.map(({ id }) => id)),
      recorded,
      { outcome: "succeeded", type: "finished" },
    ]);
    const byLabel = Object.fromEntries(applies.map((apply) => [apply.label, apply]));
    expect(byLabel["artifact-store"]?.targets).toContain(
      "module.platform.module.platform_data.aws_s3_bucket_versioning.artifacts",
    );
    expect(byLabel["lambda-microvm-prerequisites"]?.targets).toEqual([
      "module.platform.module.sandbox_runtime[0]",
    ]);
    expect(byLabel["model-runtime-secrets"]?.targets).toEqual([
      "module.platform.module.model_runtime[0].aws_ssm_parameter.runtime",
      "module.platform.module.model_runtime[0].data.aws_region.current",
    ]);
    expect(byLabel.deployment?.targets).toBeUndefined();
    expect(byLabel.deployment?.variables).toMatchObject({
      agent_observability_hot_image: "ecr/observability-hot-plane@sha256:2",
      agent_worker_image: "ecr/agent-worker@sha256:4",
      app_gateway_image: "ecr/app-gateway@sha256:8",
      bifrost_image: "ecr/bifrost@sha256:9",
      aws_account_id: "123456789012",
      aws_region: "us-east-2",
      durable_streams_image: "ecr/durable-streams@sha256:1",
      lambda_microvm_image_identifier: "arn:image",
      platform_api_artifact_key: "releases/sha256/x/platform-api.zip",
      platform_identity_publish_domain: false,
      model_gateway_image: "ecr/model-gateway@sha256:6",
      stream_gateway_image: "ecr/stream-gateway@sha256:5",
      web_tools_firecrawl_image: "ecr/firecrawl@sha256:7",
      web_tools_firecrawl_table: firecrawlTable,
      web_tools_proxy_image: "ecr/web-tools-proxy@sha256:3",
    });
    expect(byLabel["identity-domain"]?.variables.platform_identity_publish_domain).toBe(true);
    expect(result).toEqual({
      endpoint: "https://api.example.com",
      images: {
        "agent-worker": "ecr/agent-worker@sha256:4",
        "app-gateway": "ecr/app-gateway@sha256:8",
        bifrost: "ecr/bifrost@sha256:9",
        "durable-streams": "ecr/durable-streams@sha256:1",
        firecrawl: "ecr/firecrawl@sha256:7",
        "model-gateway": "ecr/model-gateway@sha256:6",
        "observability-hot-plane": "ecr/observability-hot-plane@sha256:2",
        "stream-gateway": "ecr/stream-gateway@sha256:5",
        "web-tools-proxy": "ecr/web-tools-proxy@sha256:3",
      },
      name: "acme",
      sourceCommit,
    });
  });

  test("deploys a prod-shaped account with an existing artifact store", async () => {
    const { applies, reported, result, stepCalls } = await deploy({
      after: {
        app_runtime: null,
        model_runtime_secret_arns: {},
        platform_identity_bootstrap: bootstrap(true),
      },
      profile: "platform-prod",
      state: [
        "module.platform.module.platform_data.aws_s3_bucket_versioning.artifacts",
        "module.platform.module.platform_identity[0].aws_api_gateway_domain_name.identity[0]",
      ],
    });

    expect(stepCalls).toEqual([
      "callerAccount",
      "init",
      "publishImages",
      "apply:lambda-microvm-prerequisites",
      "publishMicrovmImage",
      "publishLambdaArtifacts",
      "apply:model-runtime-secrets",
      "syncModelRuntime:prepare",
      "reconcileOrganizationGateLanes:previous:2",
      "apply:deployment",
      "verifyMicrovm",
      "bootstrapIdentity",
      "deployLambdas:true",
      "reconcileOrganizationGateLanes:released:5",
      "migrateOrganizationLimits",
      "sleepUntil:1798761600000",
      "reconcileOrganizationGateLanes:released:5",
      "sleepUntil:1798761600000",
      "switchGovernanceInventoryShardWrites",
      "sleepUntil:1798761760000",
      "recheckGovernanceInventoryShards",
      "sleepUntil:1798761600000",
      "migrateMeterEventWorkspaces",
      "sleepUntil:1798761600000",
      "migrateArtifactCreationIndex",
      "recordInstallation:9:api:",
    ]);
    expect(reported).toEqual([
      started,
      ...ran(
        "callerAccount",
        "init",
        "publishImages",
        "apply:lambda-microvm-prerequisites",
        "publishMicrovmImage",
        "publishLambdaArtifacts",
        "apply:model-runtime-secrets",
        "syncModelRuntime:prepare",
        "reconcileOrganizationGateLanes:prepare",
        "apply:deployment",
        "verifyMicrovm",
        "bootstrapIdentity",
        "deployLambdas",
        "reconcileOrganizationGateLanes:repair",
        "migrateOrganizationLimits",
        "reconcileOrganizationGateLanes:final",
        "migrateGovernanceInventoryShards",
        "migrateMeterEventWorkspaces",
        "migrateArtifactCreationIndex",
        "recordInstallation",
      ),
      recorded,
      { outcome: "succeeded", type: "finished" },
    ]);
    const byLabel = Object.fromEntries(applies.map((apply) => [apply.label, apply]));
    expect(byLabel["model-runtime-secrets"]?.targets).toEqual([
      "module.platform.module.model_runtime[0].aws_ssm_parameter.runtime",
      "module.platform.module.model_runtime[0].data.aws_region.current",
    ]);
    expect(byLabel.deployment?.variables.platform_identity_publish_domain).toBe(true);
    expect(byLabel.deployment?.variables).toHaveProperty("app_gateway_image");
    expect(byLabel.deployment?.variables).toHaveProperty("web_tools_proxy_image");
    expect(byLabel.deployment?.variables).toHaveProperty("web_tools_firecrawl_image");
    expect(byLabel.deployment?.variables).toHaveProperty("web_tools_firecrawl_table");
    expect(byLabel.deployment?.variables).toHaveProperty("lambda_microvm_image_identifier");
    expect(result.endpoint).toBeNull();
    expect(Object.keys(result.images)).toEqual([
      "agent-worker",
      "app-gateway",
      "bifrost",
      "durable-streams",
      "firecrawl",
      "model-gateway",
      "observability-hot-plane",
      "stream-gateway",
      "web-tools-proxy",
    ]);
  });

  test("publishes the identity domain in the full plan when the bootstrap marker matches", async () => {
    const { applies, stepCalls } = await deploy({
      after: { platform_identity_bootstrap: bootstrap(true) },
      before: { platform_identity_bootstrap: bootstrap(true) },
      marker: webSecretArn,
      profile: "platform-prod",
      state: ["module.platform.module.platform_data.aws_s3_bucket_versioning.artifacts"],
    });
    expect(stepCalls).toContain("readIdentityMarker");
    expect(stepCalls).not.toContain("apply:identity-domain");
    expect(applies.find((apply) => apply.label === "deployment")?.variables).toMatchObject({
      platform_identity_publish_domain: true,
    });
  });

  test("keeps the identity domain unpublished until publication is ready", async () => {
    const { applies, stepCalls } = await deploy({
      after: { platform_identity_bootstrap: bootstrap(false) },
      before: { platform_identity_bootstrap: bootstrap(false) },
      marker: "arn:aws:secretsmanager:us-east-2:123456789012:secret:previous",
      profile: "platform-prod",
      state: ["module.platform.module.platform_data.aws_s3_bucket_versioning.artifacts"],
    });
    expect(stepCalls).toContain("bootstrapIdentity");
    expect(stepCalls).not.toContain("apply:identity-domain");
    expect(applies.find((apply) => apply.label === "deployment")?.variables).toMatchObject({
      platform_identity_publish_domain: false,
    });
  });

  test("re-applies the artifact store when state lacks an output publication reads", async () => {
    const { stepCalls } = await deploy({
      after: {},
      profile: "platform-prod",
      state: ["module.platform.module.platform_data.aws_s3_bucket_versioning.artifacts"],
      storeBefore: { artifact_bucket_name: "artifacts", artifact_kms_key_arn: "arn:kms" },
    });
    expect(stepCalls.slice(0, 4)).toEqual([
      "callerAccount",
      "init",
      "apply:artifact-store",
      "publishImages",
    ]);
  });

  test("refuses to deploy Firecrawl without the release's table definition", async () => {
    expect(
      deploy({ after: {}, profile: "platform-dev", releaseImages: {}, state: [] }),
    ).rejects.toThrow("Release has no dynamodb-table.json for firecrawl.");
  });

  test("stops before OpenTofu when credentials belong to another account", async () => {
    const reported: DeployEventBody[] = [];
    expect(
      deploy({ account: "999999999999", after: {}, profile: "platform-dev", reported, state: [] }),
    ).rejects.toThrow("Expected AWS account 123456789012, received 999999999999.");
    expect(reported).toEqual([
      started,
      { stage: "callerAccount", type: "stage-started" },
      {
        message: "Expected AWS account 123456789012, received 999999999999.",
        stage: "callerAccount",
        type: "stage-failed",
      },
      { outcome: "failed", type: "finished" },
    ]);
  });

  test("records the installation only after public verification succeeds", async () => {
    const scenario = {
      after: { platform_api_endpoint: "https://api.example.com" },
      profile: "platform-prod",
      state: ["module.platform.module.platform_data.aws_s3_bucket_versioning.artifacts"],
    } as const;
    const { stepCalls } = await deploy(scenario);
    expect(stepCalls.slice(-12)).toEqual([
      "verifyPublicSurface:https://api.example.com",
      "sleepUntil:1798761600000",
      "reconcileOrganizationGateLanes:released:3",
      "sleepUntil:1798761600000",
      "switchGovernanceInventoryShardWrites",
      "sleepUntil:1798761760000",
      "recheckGovernanceInventoryShards",
      "sleepUntil:1798761600000",
      "migrateMeterEventWorkspaces",
      "sleepUntil:1798761600000",
      "migrateArtifactCreationIndex",
      "recordInstallation:9:api:https://api.example.com",
    ]);

    const failed: string[] = [];
    const reported: DeployEventBody[] = [];
    expect(deploy({ ...scenario, reported, stepCalls: failed, verifyFails: true })).rejects.toThrow(
      "public surface is unhealthy",
    );
    expect(failed).toContain("verifyPublicSurface:https://api.example.com");
    expect(failed.some((event) => event.startsWith("recordInstallation"))).toBe(false);
    expect(reported).toEqual([
      started,
      ...ran(
        "callerAccount",
        "init",
        "publishImages",
        "apply:lambda-microvm-prerequisites",
        "publishMicrovmImage",
        "publishLambdaArtifacts",
        "apply:model-runtime-secrets",
        "syncModelRuntime:prepare",
        "reconcileOrganizationGateLanes:prepare",
        "apply:deployment",
        "verifyMicrovm",
        "deployLambdas",
        "reconcileOrganizationGateLanes:repair",
        "migrateOrganizationLimits",
      ),
      { stage: "verifyPublicSurface", type: "stage-started" },
      {
        message: "public surface is unhealthy",
        stage: "verifyPublicSurface",
        type: "stage-failed",
      },
      { outcome: "failed", type: "finished" },
    ]);
  });

  test("records the released Lambda artifacts and reports the recorded installation", async () => {
    const table = fakeDynamoDocumentClient();
    const repository = makeInstallationRepository(
      makeDynamoDatabase(table.client, DEFAULT_TABLE_NAMES),
    );
    const release = {
      artifacts: { "platform-api": { path: "/bundle/api.zip", sha256: "1".repeat(64) } },
      images: {},
      manifestSha256: "5".repeat(64),
      sourceCommit,
    } as unknown as VerifiedRelease;
    const scenario = {
      after: { platform_api_endpoint: "https://api.example.com" },
      profile: "platform-prod",
      recordInstallation: (deployed) =>
        recordInstallation(
          { client: table.client, tableNames: DEFAULT_TABLE_NAMES },
          {
            ...deployed,
            deployedBy: "arn:aws:sts::123456789012:assumed-role/deployer/ci",
            release,
            target: target("platform-prod"),
          },
        ),
      state: ["module.platform.module.platform_data.aws_s3_bucket_versioning.artifacts"],
    } satisfies Scenario;
    const released = {
      functions: [{ codeSha256: "a".repeat(64), name: "api" }],
      name: "platform-api",
      sha256: "1".repeat(64),
    };

    const { reported } = await deploy(scenario);
    expect(await repository.current()).toMatchObject({ lambdaArtifacts: [released], version: 1 });
    expect(
      (await repository.listDeployments()).items.map((deployment) => deployment.lambdaArtifacts),
    ).toEqual([[released]]);
    const recordedEvent = reported.at(-2);
    expect(recordedEvent).toMatchObject({
      installation: {
        endpoints: [{ name: "platform-api", url: "https://api.example.com" }],
        lambdaArtifacts: [released],
        profile: "platform-prod",
        targetName: "acme",
        version: 1,
      },
      type: "recorded",
    });
    expect(
      recordedEvent?.type === "recorded" && Object.keys(recordedEvent.installation).toSorted(),
    ).toEqual([
      "awsAccountId",
      "awsRegion",
      "deployedAt",
      "deployedBy",
      "deploymentId",
      "endpoints",
      "images",
      "lambdaArtifacts",
      "profile",
      "releaseManifestSha256",
      "sourceCommit",
      "targetName",
      "updatedAt",
      "version",
    ]);
  });
});
