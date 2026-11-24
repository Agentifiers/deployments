import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  NonEmptyString,
  NonNegativeSafeInteger,
  Timestamp,
  makeRecordSchema,
} from "../record-schema.ts";

const MAX_INSTALLATION_ENTRIES = 128;

const Sha256Hex = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)));
const BoundedName = NonEmptyString.pipe(Schema.check(Schema.isMaxLength(256)));
const BoundedText = NonEmptyString.pipe(Schema.check(Schema.isMaxLength(2_048)));
const bounded = <S extends Schema.Top>(item: S) =>
  Schema.Array(item).pipe(Schema.check(Schema.isMaxLength(MAX_INSTALLATION_ENTRIES)));

export const InstallationLambdaArtifact = Schema.Struct({
  functions: bounded(Schema.Struct({ codeSha256: Sha256Hex, name: BoundedName })),
  name: BoundedName,
  sha256: Sha256Hex,
});

/** One container image published by the release, pinned by its registry digest. */
export const InstallationImage = Schema.Struct({
  imageId: Schema.String.pipe(Schema.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u))),
  name: BoundedName,
  uri: BoundedText.pipe(Schema.check(Schema.isPattern(/@sha256:[0-9a-f]{64}$/u))),
});

export const InstallationEndpoint = Schema.Struct({
  name: BoundedName,
  url: BoundedText,
});

/**
 * What one deploy-tool run put into the account. The installation singleton and every history
 * entry carry the same snapshot so the history stays self-describing after later deployments.
 */
const installationSnapshotFields = {
  awsAccountId: Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{12}$/u))),
  awsRegion: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z]{2}(?:-[a-z]+)+-\d$/u))),
  deployedAt: Timestamp,
  deployedBy: BoundedText,
  endpoints: bounded(InstallationEndpoint),
  images: bounded(InstallationImage),
  lambdaArtifacts: bounded(InstallationLambdaArtifact),
  profile: BoundedName,
  releaseManifestSha256: Sha256Hex,
  sourceCommit: Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{40}$/u))),
  targetName: BoundedName,
} as const;

/** The install's current release; a platform-global singleton replaced by each deployment. */
export const InstallationRecord = makeRecordSchema("installation", {
  ...installationSnapshotFields,
  createdAt: Timestamp,
  deploymentId: Ulid,
  id: Schema.Literal("current"),
  updatedAt: Timestamp,
  version: NonNegativeSafeInteger,
});

/** Create-only history of deploy-tool runs, ordered by their time-sortable ULID. */
export const InstallationDeploymentRecord = makeRecordSchema("installation-deployment", {
  ...installationSnapshotFields,
  createdAt: Timestamp,
  id: Ulid,
});

/**
 * A one-time data migration the deploy tool or an operator script finished; later runs skip it after
 * one read.
 */
export const DeployMigrationRecord = makeRecordSchema("deploy-migration", {
  completedAt: Timestamp,
  id: Schema.Literals([
    "artifact-creation-index",
    "governance-inventory-shard-recheck",
    "governance-inventory-shard-writes",
    "governance-inventory-shards",
    "meter-event-workspaces",
    "organization-limits",
  ]),
});

export const SYSTEM_RECORD_SCHEMAS = {
  "deploy-migration": DeployMigrationRecord,
  installation: InstallationRecord,
  "installation-deployment": InstallationDeploymentRecord,
} as const;
