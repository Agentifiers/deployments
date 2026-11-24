import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  makeDynamoDatabase,
  makeInstallationRepository,
  type InstallationDeploymentInput,
  type TableNames,
} from "@deployments-ai/db";
import type { ReleasedLambdaFunction } from "./lambda-release.ts";
import { log } from "./process.ts";
import type { PlatformImageName } from "./profiles.ts";
import type { VerifiedRelease } from "./release-bundle.ts";
import type { DeploymentTarget } from "./target.ts";
import type { TerraformOutputs } from "./terraform.ts";

/** Public endpoints worth showing an operator, keyed by the OpenTofu output that carries them. */
export const endpointOutputs = {
  agent_runtime_api_endpoint: "runtime-api",
  channel_provider_api_endpoint: "channel-provider-api",
  console_url: "console",
  memory_api_endpoint: "memory-api",
  platform_api_endpoint: "platform-api",
  platform_identity_issuer: "identity",
  stream_gateway_base_url: "stream-gateway",
} as const;

export interface InstallationRecordInput {
  readonly deployedBy: string;
  /** Digest-pinned image URIs the release published. */
  readonly images: Readonly<Partial<Record<PlatformImageName, string>>>;
  readonly lambdaFunctions: readonly ReleasedLambdaFunction[];
  readonly outputs: TerraformOutputs;
  readonly release: Pick<
    VerifiedRelease,
    "artifacts" | "images" | "manifestSha256" | "sourceCommit"
  >;
  readonly target: DeploymentTarget;
}

/** Builds the installation snapshot of one verified deployment. */
function installationDeployment(input: InstallationRecordInput): InstallationDeploymentInput {
  const { release, target } = input;
  return {
    awsAccountId: target.aws.accountId,
    awsRegion: target.aws.region,
    deployedBy: input.deployedBy,
    endpoints: Object.entries(endpointOutputs).flatMap(([output, name]) => {
      const url = input.outputs[output];
      return typeof url === "string" && url ? [{ name, url }] : [];
    }),
    images: Object.entries(input.images).flatMap(([name, uri]) => {
      const image = release.images[name as PlatformImageName];
      return uri && image ? [{ imageId: image.digest, name, uri }] : [];
    }),
    lambdaArtifacts: Object.entries(release.artifacts)
      .map(([name, artifact]) => ({
        functions: input.lambdaFunctions
          .filter((released) => released.artifact === name)
          .map((released) => ({ codeSha256: released.codeSha256, name: released.functionName })),
        name,
        sha256: artifact.sha256,
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
    profile: target.profileName,
    releaseManifestSha256: release.manifestSha256,
    sourceCommit: release.sourceCommit,
    targetName: target.name,
  };
}

/** Records a verified deployment as the installation's current release and history entry. */
export async function recordInstallation(
  tables: { readonly client: DynamoDBDocumentClient; readonly tableNames: TableNames },
  input: InstallationRecordInput,
) {
  const repository = makeInstallationRepository(
    makeDynamoDatabase(tables.client, tables.tableNames),
  );
  const { deployment, installation } = await repository.recordDeployment(
    installationDeployment(input),
  );
  log(`recorded installation deployment ${deployment.id} for ${deployment.sourceCommit}`);
  return installation;
}

/** A document client over the target's own platform tables. */
export function dynamoPlatformTables(outputs: TerraformOutputs, region: string) {
  const tableNames = outputs.dynamodb_table_names;
  if (
    tableNames === null ||
    typeof tableNames !== "object" ||
    !["control", "events", "execution", "usage"].every(
      (table) => typeof Reflect.get(tableNames, table) === "string",
    )
  ) {
    throw new Error("OpenTofu output dynamodb_table_names does not name the platform tables.");
  }
  return {
    client: DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    tableNames: tableNames as TableNames,
  };
}
