import { deploymentArtifacts, type DeploymentArtifactName } from "../build-deployment-artifacts.ts";
import { type CommandRunner, CommandFailure, log } from "./process.ts";
import type { VerifiedRelease } from "./release-bundle.ts";

const sha256Pattern = /^[0-9a-f]{64}$/;

const releaseArtifactVariablePrefixes = {
  "agent-email-runtime": "agent_email",
  "agent-runtime": "agent_runtime",
  "app-domains": "app_domains",
  "apps-database": "apps_database",
  "channel-provider-runtime": "channel_provider",
  console: "console",
  "document-extraction": "document_extraction",
  "event-analytics-projector": "event_analytics_projector",
  "event-dispatcher": "event_dispatcher",
  "identity-api": "platform_identity_api",
  "identity-email-worker": "platform_identity_email",
  "memory-runtime": "memory_runtime",
  "ops-alerts-notifier": "ops_alerts_notifier",
  "platform-api": "platform_api",
} as const satisfies Record<DeploymentArtifactName, string>;

interface PublishedArtifact {
  readonly key: string;
  readonly version: string;
}

interface StoredArtifactMetadata {
  readonly ChecksumSHA256?: unknown;
  readonly ContentLength?: unknown;
  readonly Metadata?: unknown;
  readonly ServerSideEncryption?: unknown;
  readonly SSEKMSKeyId?: unknown;
  readonly VersionId?: unknown;
}

export function contentAddressedArtifactKey(name: DeploymentArtifactName, sha256: string) {
  if (!sha256Pattern.test(sha256)) throw new TypeError(`Invalid SHA-256 for ${name}.`);
  return `releases/sha256/${sha256}/${name}.zip`;
}

export function buildReleaseVariables(
  bucket: string,
  artifacts: Readonly<Record<DeploymentArtifactName, PublishedArtifact>>,
) {
  const variables: Record<string, boolean | string> = { platform_identity_enabled: true };
  for (const name of Object.keys(deploymentArtifacts) as DeploymentArtifactName[]) {
    const prefix = releaseArtifactVariablePrefixes[name];
    const artifact = artifacts[name];
    variables[`${prefix}_artifact_bucket`] = bucket;
    variables[`${prefix}_artifact_key`] = artifact.key;
    variables[`${prefix}_artifact_version`] = artifact.version;
  }
  return variables;
}

export function verifyStoredArtifact(
  value: StoredArtifactMetadata,
  expected: {
    readonly checksum: string;
    readonly kmsKeyArn: string;
    readonly sha256: string;
    readonly size: number;
  },
) {
  const metadata =
    value.Metadata !== null && typeof value.Metadata === "object"
      ? (value.Metadata as Readonly<Record<string, unknown>>)
      : {};
  if (value.ChecksumSHA256 !== expected.checksum) {
    throw new Error("The existing artifact checksum does not match its content address.");
  }
  if (value.ContentLength !== expected.size) {
    throw new Error("The existing artifact length does not match the local archive.");
  }
  if (metadata.sha256 !== expected.sha256) {
    throw new Error("The existing artifact metadata does not match its content address.");
  }
  if (value.ServerSideEncryption !== "aws:kms" || value.SSEKMSKeyId !== expected.kmsKeyArn) {
    throw new Error("The existing artifact does not use the required KMS key.");
  }
  if (typeof value.VersionId !== "string" || !value.VersionId || value.VersionId === "null") {
    throw new Error("The artifact bucket must return an immutable object version.");
  }
  return value.VersionId;
}

function decodeJson(value: string, label: string): StoredArtifactMetadata {
  try {
    const decoded: unknown = JSON.parse(value);
    if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new TypeError(`${label} did not return an object.`);
    }
    return decoded as StoredArtifactMetadata;
  } catch (cause) {
    throw new Error(`Unable to decode ${label}.`, { cause });
  }
}

function isMissingObject(error: unknown) {
  return (
    error instanceof CommandFailure &&
    (error.stderr.includes("(404)") ||
      error.stderr.includes("Not Found") ||
      error.stderr.includes("NoSuchKey"))
  );
}

async function publishArtifact(input: {
  readonly archivePath: string;
  readonly bucket: string;
  readonly checksum: string;
  readonly key: string;
  readonly kmsKeyArn: string;
  readonly run: CommandRunner;
  readonly sha256: string;
  readonly size: number;
}) {
  const expected = {
    checksum: input.checksum,
    kmsKeyArn: input.kmsKeyArn,
    sha256: input.sha256,
    size: input.size,
  };
  try {
    const existing = await input.run([
      "aws",
      "s3api",
      "head-object",
      "--bucket",
      input.bucket,
      "--key",
      input.key,
      "--checksum-mode",
      "ENABLED",
      "--output",
      "json",
    ]);
    return {
      reused: true,
      version: verifyStoredArtifact(decodeJson(existing, "S3 head-object"), expected),
    };
  } catch (error) {
    if (!isMissingObject(error)) throw error;
  }

  const created = await input.run([
    "aws",
    "s3api",
    "put-object",
    "--body",
    input.archivePath,
    "--bucket",
    input.bucket,
    "--key",
    input.key,
    "--checksum-sha256",
    input.checksum,
    "--metadata",
    `sha256=${input.sha256}`,
    "--server-side-encryption",
    "aws:kms",
    "--ssekms-key-id",
    input.kmsKeyArn,
    "--output",
    "json",
  ]);
  const response = decodeJson(created, "S3 put-object");
  if (typeof response.VersionId !== "string" || !response.VersionId) {
    throw new Error("The artifact bucket must have S3 versioning enabled.");
  }
  return { reused: false, version: response.VersionId };
}

/**
 * Publishes verified Lambda archives to content-addressed, versioned S3 keys
 * and returns the OpenTofu release variables that pin those versions.
 */
export async function publishLambdaArtifacts(input: {
  readonly bucket: string;
  readonly kmsKeyArn: string;
  readonly release: VerifiedRelease;
  readonly run: CommandRunner;
}) {
  const published = {} as Record<DeploymentArtifactName, PublishedArtifact>;
  for (const name of Object.keys(deploymentArtifacts) as DeploymentArtifactName[]) {
    const artifact = input.release.artifacts[name];
    const key = contentAddressedArtifactKey(name, artifact.sha256);
    const result = await publishArtifact({
      archivePath: artifact.path,
      bucket: input.bucket,
      checksum: Buffer.from(artifact.sha256, "hex").toString("base64"),
      key,
      kmsKeyArn: input.kmsKeyArn,
      run: input.run,
      sha256: artifact.sha256,
      size: Bun.file(artifact.path).size,
    });
    published[name] = { key, version: result.version };
    log(`artifact ${result.reused ? "reused" : "published"} ${name}`);
  }
  return buildReleaseVariables(input.bucket, published);
}
