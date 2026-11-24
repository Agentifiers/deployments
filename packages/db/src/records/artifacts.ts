import {
  DOCUMENT_MEDIA_TYPES,
  DOCUMENT_TEXT_EXTRACTOR,
  INPUT_ARTIFACT_TYPE,
  INPUT_AUDIO_MEDIA_TYPES,
  INPUT_FILE_UNUSABLE_REASONS,
  INPUT_IMAGE_MEDIA_TYPES,
  MAX_DOCUMENT_TEXT_BYTES,
} from "@deployments-ai/agent-manifest";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import { IngressSource, type RunInitiatingCaller } from "./conversations.ts";
import {
  BlobReference,
  MAX_DYNAMODB_ITEM_BYTES,
  Metadata,
  ObservabilitySourceContext,
  Timestamp,
  dynamoItemByteSize,
  makeRecordSchema,
  mutableResourceFields,
  tenantScopeFields,
} from "../record-schema.ts";

export const ARTIFACT_TYPES = [
  "deploy_log",
  "diff",
  "generated_file",
  "preview",
  "report",
  "rollback_metadata",
  "screenshot",
] as const;

export const ArtifactType = Schema.Literals(ARTIFACT_TYPES);

export const ArtifactOwner = Schema.Union([
  Schema.Struct({ principalId: Ulid, type: Schema.Literal("principal") }),
  Schema.Struct({ serviceAccountId: Ulid, type: Schema.Literal("service-account") }),
  IngressSource,
]);
export type ArtifactOwner = typeof ArtifactOwner.Type;

export function artifactOwnerOf(caller: RunInitiatingCaller): ArtifactOwner {
  switch (caller.type) {
    case "principal":
      return { principalId: caller.principalId, type: "principal" };
    case "service-account":
      return { serviceAccountId: caller.serviceAccountId, type: "service-account" };
    case "ingress":
      return { sourceId: caller.sourceId, sourceKind: caller.sourceKind, type: "ingress" };
    default: {
      const unhandled: never = caller;
      return unhandled;
    }
  }
}

/**
 * People and service accounts chose their media, so unusable media fails the turn. A provider only
 * offers ingress media, so unusable media is omitted.
 */
export function inputMediaPolicyOf(owner: ArtifactOwner): "offer" | "require" {
  switch (owner.type) {
    case "principal":
    case "service-account":
      return "require";
    case "ingress":
      return "offer";
    default: {
      const unhandled: never = owner;
      return unhandled;
    }
  }
}

export function sameArtifactOwner(owner: ArtifactOwner | undefined, expected: ArtifactOwner) {
  switch (expected.type) {
    case "principal":
      return owner?.type === "principal" && owner.principalId === expected.principalId;
    case "service-account":
      return (
        owner?.type === "service-account" && owner.serviceAccountId === expected.serviceAccountId
      );
    case "ingress":
      return (
        owner?.type === "ingress" &&
        owner.sourceKind === expected.sourceKind &&
        owner.sourceId === expected.sourceId
      );
    default: {
      const unhandled: never = expected;
      return unhandled;
    }
  }
}

export interface ArtifactStorageScope {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

function customerArtifactPrefix(scope: ArtifactStorageScope, artifactId: string, sha256: string) {
  return [
    "artifacts",
    "organizations",
    scope.organizationId,
    "projects",
    scope.projectId,
    "environments",
    scope.environmentId,
    "customer",
    artifactId,
    sha256,
  ].join("/");
}

export function customerArtifactStorageKey(
  scope: ArtifactStorageScope,
  artifactId: string,
  sha256: string,
  fileName: string,
) {
  return `${customerArtifactPrefix(scope, artifactId, sha256)}/${encodeURIComponent(fileName)}`;
}

export const INPUT_FILE_TEXT_OBJECT_NAME = `${DOCUMENT_TEXT_EXTRACTOR}.txt`;

export function inputFileTextKey(scope: ArtifactStorageScope, artifactId: string, sha256: string) {
  return `${customerArtifactPrefix(scope, artifactId, sha256)}/text/${INPUT_FILE_TEXT_OBJECT_NAME}`;
}

export const INGRESS_ATTACHMENT_OBJECT_NAME = "@input";

export function ingressAttachmentObjectKey(
  scope: ArtifactStorageScope,
  artifactId: string,
  sha256: string,
) {
  return `${customerArtifactPrefix(scope, artifactId, sha256)}/${INGRESS_ATTACHMENT_OBJECT_NAME}`;
}

const Sha256Hex = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/u)));

export const MAX_DOCUMENT_SUMMARY_LENGTH = 200;

export const ArtifactInputFile = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("image"),
    mediaType: Schema.Literals(INPUT_IMAGE_MEDIA_TYPES),
  }),
  Schema.Struct({
    kind: Schema.Literal("audio"),
    mediaType: Schema.Literals(INPUT_AUDIO_MEDIA_TYPES),
  }),
  Schema.Struct({
    kind: Schema.Literal("document"),
    mediaType: Schema.Literals(DOCUMENT_MEDIA_TYPES),
    summary: Schema.String.pipe(Schema.check(Schema.isMaxLength(MAX_DOCUMENT_SUMMARY_LENGTH))),
    text: Schema.Struct({
      byteSize: Schema.Number.pipe(
        Schema.check(
          Schema.isInt(),
          Schema.isGreaterThanOrEqualTo(1),
          Schema.isLessThanOrEqualTo(MAX_DOCUMENT_TEXT_BYTES),
        ),
      ),
      extractor: Schema.Literal(DOCUMENT_TEXT_EXTRACTOR),
      sha256: Sha256Hex,
      truncated: Schema.Boolean,
      versionId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("unusable"),
    reason: Schema.Literals(INPUT_FILE_UNUSABLE_REASONS),
    detail: Schema.optional(Schema.String.pipe(Schema.check(Schema.isMaxLength(200)))),
  }),
]);
export type ArtifactInputFile = typeof ArtifactInputFile.Type;

export const ArtifactRecord = makeRecordSchema(
  "artifact",
  {
    ...mutableResourceFields,
    ...tenantScopeFields,
    accessUrlExpiresAt: Schema.optional(Timestamp),
    agentDeploymentId: Schema.optional(Ulid),
    id: Ulid,
    input: Schema.optional(ArtifactInputFile),
    metadata: Schema.optional(Metadata),
    name: Schema.String,
    observability: Schema.optional(ObservabilitySourceContext),
    owner: Schema.optional(ArtifactOwner),
    privateAccess: Schema.optional(Schema.Literals(["brain-authorized", "runtime-only"])),
    retentionExpiresAt: Schema.optional(Timestamp),
    runId: Schema.optional(Ulid),
    status: Schema.Literals(["available", "deleted", "failed", "pending"]),
    storage: BlobReference,
    threadId: Schema.optional(Ulid),
    type: Schema.String,
    uploadExpiresAt: Schema.optional(Timestamp),
    uploadUrlExpiresAt: Schema.optional(Timestamp),
    visibility: Schema.Literals(["organization", "private", "public"]),
  },
  {
    expiresAtFields: ["retentionExpiresAt", "uploadExpiresAt"],
    expiresAtRequired: false,
  },
).pipe(
  Schema.refine(
    (record): record is typeof record => dynamoItemByteSize(record) <= MAX_DYNAMODB_ITEM_BYTES,
    {
      identifier: "ArtifactDynamoItemSize",
      message: "Artifact records must fit in one DynamoDB item.",
    },
  ),
  Schema.refine(
    (record): record is typeof record =>
      record.data.input === undefined ||
      (record.data.type === INPUT_ARTIFACT_TYPE && record.data.status !== "pending"),
    {
      identifier: "ArtifactInputFileResolution",
      message: "Only a completed input artifact carries an input file resolution.",
    },
  ),
);
