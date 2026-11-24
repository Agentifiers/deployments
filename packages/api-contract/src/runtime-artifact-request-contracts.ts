import { Schema } from "effect";
import { Metadata, PublicId, Timestamp } from "./primitives.ts";
import { trimmedText } from "./runtime-request-contracts.ts";

export const ArtifactAccessExpirationSeconds = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({
      message: "Artifact access URL expiration must be an integer.",
    }),
    Schema.isGreaterThanOrEqualTo(60, {
      message: "Artifact access URL expiration must be at least 60 seconds.",
    }),
    Schema.isLessThanOrEqualTo(3600, {
      message: "Artifact access URL expiration must not exceed 3600 seconds.",
    }),
  ),
);

export const CreateArtifactAccessUrlRequest = Schema.Struct({
  /** `attachment` makes a browser save the file instead of rendering it. */
  disposition: Schema.optional(Schema.Literals(["attachment", "inline"])),
  expiresInSeconds: Schema.optional(ArtifactAccessExpirationSeconds),
});

export const ArtifactFileName = trimmedText("Artifact file name", 255).pipe(
  Schema.check(
    Schema.makeFilter<string>((value) =>
      new TextEncoder().encode(value).byteLength <= 255
        ? undefined
        : "Artifact file names must not exceed 255 UTF-8 bytes.",
    ),
    Schema.makeFilter<string>((value) =>
      value === "." ||
      value === ".." ||
      Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0)!;
        return character === "/" || character === "\\" || codePoint <= 0x1f || codePoint === 0x7f;
      })
        ? "Artifact file names must not contain path separators or control characters."
        : undefined,
    ),
  ),
);

export const ArtifactContentType = trimmedText("Artifact content type", 255).pipe(
  Schema.check(
    Schema.isPattern(/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;\s*[\w!#$&^_.+-]+=[^;\r\n]+)*$/u, {
      message: "Artifact content type must be a valid media type.",
    }),
  ),
);

export const ArtifactByteSize = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Artifact byte size must be an integer." }),
    Schema.isGreaterThan(0, {
      message: "Artifact byte size must be positive.",
    }),
    Schema.isLessThanOrEqualTo(100 * 1024 * 1024, {
      message: "Customer artifact uploads must not exceed 104857600 bytes.",
    }),
  ),
);

export const ArtifactSha256 = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^[a-f0-9]{64}$/u, {
      message: "Artifact sha256 must be a lowercase hexadecimal SHA-256 digest.",
    }),
  ),
);

export const MAX_ARTIFACT_METADATA_BYTES = 128 * 1024;
export const ArtifactMetadata = Metadata.pipe(
  Schema.check(
    Schema.makeFilter<Readonly<Record<string, unknown>>>((value) =>
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_ARTIFACT_METADATA_BYTES
        ? undefined
        : `Artifact metadata must not exceed ${MAX_ARTIFACT_METADATA_BYTES} encoded bytes.`,
    ),
  ),
);

export const CreateArtifactUploadRequest = Schema.Struct({
  byteSize: ArtifactByteSize,
  contentType: ArtifactContentType,
  fileName: ArtifactFileName,
  metadata: Schema.optional(ArtifactMetadata),
  name: trimmedText("Artifact name", 255),
  retentionExpiresAt: Schema.optional(Timestamp),
  runId: Schema.optional(PublicId),
  sha256: ArtifactSha256,
  threadId: Schema.optional(PublicId),
  type: trimmedText("Artifact type", 100),
  visibility: Schema.optional(Schema.Literals(["organization", "private"])),
});

export const UpdateArtifactRetentionRequest = Schema.Struct({
  expectedVersion: Schema.Number.pipe(
    Schema.check(
      Schema.isInt({
        message: "Artifact expected version must be an integer.",
      }),
      Schema.isGreaterThanOrEqualTo(0),
    ),
  ),
  retentionExpiresAt: Schema.NullOr(Timestamp),
});
