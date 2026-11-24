import { Schema } from "effect";
import {
  Cursor,
  Metadata,
  PublicId,
  ResourceDescription,
  ResourceName,
  Timestamp,
} from "./primitives.ts";

const ResourceVersion = Schema.Number.pipe(
  Schema.check(
    Schema.isInt({ message: "Managed skill resource versions must be integers." }),
    Schema.isGreaterThanOrEqualTo(0),
  ),
);

const SkillKey = Schema.String.pipe(
  Schema.check(
    Schema.isTrimmed({ message: "Managed skill keys must not contain surrounding whitespace." }),
    Schema.isPattern(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u, {
      message: "Managed skill keys must be normalized lowercase identifiers.",
    }),
    Schema.isMaxLength(128),
  ),
);

const CanonicalHash = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(/^sha256:[a-f0-9]{64}$/u, {
      message: "Managed skill hashes must be canonical SHA-256 values.",
    }),
  ),
);

const RepositoryUrl = Schema.String.pipe(
  Schema.check(
    Schema.isMaxLength(2_048),
    Schema.makeFilter<string>((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
          ? undefined
          : "Managed skill repository URLs must use HTTPS without credentials, query strings, or fragments.";
      } catch {
        return "Managed skill repository URL is invalid.";
      }
    }),
  ),
);

const MAX_MANAGED_SKILL_ITEM_PAYLOAD_BYTES = 320 * 1024;
const MAX_IDEMPOTENT_RESOURCE_PAYLOAD_BYTES = 192 * 1024;
const MAX_MANAGED_SKILLS_PER_RELEASE = 96;
const encodedSizeFilter = (label: string, maximum = MAX_MANAGED_SKILL_ITEM_PAYLOAD_BYTES) =>
  Schema.makeFilter<unknown>((value) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= maximum
      ? undefined
      : `${label} must not exceed ${maximum} encoded bytes.`,
  );

const ManagedSkillSourceMetadata = Metadata.pipe(
  Schema.check(
    encodedSizeFilter("Managed skill source metadata", MAX_IDEMPOTENT_RESOURCE_PAYLOAD_BYTES),
  ),
);

export const CreateManagedSkillSourceRequest = Schema.Struct({
  key: SkillKey,
  licenseHash: Schema.optional(CanonicalHash),
  metadata: Schema.optional(ManagedSkillSourceMetadata),
  name: ResourceName,
  pinnedCommit: Schema.optional(
    Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{40,64}$/u))),
  ),
  repositoryUrl: Schema.optional(RepositoryUrl),
});

export const UpdateManagedSkillSourceRequest = Schema.Struct({
  expectedVersion: ResourceVersion,
  licenseHash: Schema.optional(Schema.NullOr(CanonicalHash)),
  metadata: Schema.optional(Schema.NullOr(ManagedSkillSourceMetadata)),
  name: Schema.optional(ResourceName),
  pinnedCommit: Schema.optional(
    Schema.NullOr(Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{40,64}$/u)))),
  ),
  repositoryUrl: Schema.optional(Schema.NullOr(RepositoryUrl)),
}).pipe(
  Schema.check(
    Schema.isMinProperties(2, {
      message: "Managed skill source updates must change at least one field.",
    }),
  ),
);

export const ArchiveManagedSkillResourceRequest = Schema.Struct({
  expectedVersion: ResourceVersion,
});

const ManagedSkillContent = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((value) =>
      new TextEncoder().encode(value).byteLength <= 256 * 1024
        ? undefined
        : "Managed skill content must not exceed 262144 UTF-8 bytes.",
    ),
  ),
);

const ManagedSkillDependencies = Schema.Array(SkillKey).pipe(
  Schema.check(
    Schema.isMaxLength(MAX_MANAGED_SKILLS_PER_RELEASE, {
      message: `Managed skills may declare at most ${MAX_MANAGED_SKILLS_PER_RELEASE} dependencies.`,
    }),
    Schema.makeFilter<readonly (typeof SkillKey.Type)[]>((dependencies) =>
      new Set(dependencies).size === dependencies.length
        ? undefined
        : "Managed skill dependencies must be unique.",
    ),
  ),
);

function isManagedSkillReferencePath(path: string) {
  const segments = path.split("/");
  return (
    path.length <= 512 &&
    segments.length > 1 &&
    segments[0] === "references" &&
    segments
      .slice(1)
      .every(
        (segment) =>
          segment.length > 0 &&
          segment !== "." &&
          segment !== ".." &&
          /^[A-Za-z0-9._-]+$/u.test(segment),
      )
  );
}

const ManagedSkillReferencePath = Schema.String.pipe(
  Schema.check(
    Schema.makeFilter<string>((path) =>
      isManagedSkillReferencePath(path)
        ? undefined
        : "Managed skill reference paths must be normalized paths below references/.",
    ),
    Schema.isMaxLength(512),
  ),
);

const ManagedSkillReferences = Schema.Record(Schema.String, ManagedSkillContent).pipe(
  Schema.check(
    Schema.makeFilter<Readonly<Record<string, string>>>((references) => {
      const paths = Object.keys(references);
      if (paths.length > 128) return "Managed skills may contain at most 128 reference files.";
      return paths.every(isManagedSkillReferencePath)
        ? undefined
        : "Managed skill reference paths must be normalized paths below references/.";
    }),
  ),
);

export const ManagedSkillReleaseEntry = Schema.Struct({
  content: ManagedSkillContent,
  dependencies: Schema.optional(ManagedSkillDependencies),
  description: Schema.optional(ResourceDescription),
  key: SkillKey,
  metadata: Schema.optional(Metadata),
  references: Schema.optional(ManagedSkillReferences),
}).pipe(Schema.check(encodedSizeFilter("Managed skill entries")));

const ManagedSkillManifest = Metadata.pipe(
  Schema.check(encodedSizeFilter("Managed skill manifests", MAX_IDEMPOTENT_RESOURCE_PAYLOAD_BYTES)),
);

const SEMANTIC_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;

export const PublishManagedSkillReleaseRequest = Schema.Struct({
  expectedSourceVersion: ResourceVersion,
  manifest: Schema.optional(ManagedSkillManifest),
  releaseVersion: Schema.String.pipe(
    Schema.check(
      Schema.isTrimmed(),
      Schema.isMaxLength(255),
      Schema.isPattern(SEMANTIC_VERSION, {
        message: "Managed skill releaseVersion must be a semantic version.",
      }),
    ),
  ),
  skills: Schema.Array(ManagedSkillReleaseEntry).pipe(
    Schema.check(
      Schema.isMinLength(1, { message: "Managed skill releases require at least one skill." }),
      Schema.isMaxLength(MAX_MANAGED_SKILLS_PER_RELEASE, {
        message: `Managed skill releases may contain at most ${MAX_MANAGED_SKILLS_PER_RELEASE} skills so publication and invariant checks fit one atomic transaction.`,
      }),
      Schema.makeFilter<readonly (typeof ManagedSkillReleaseEntry.Type)[]>((skills) =>
        new Set(skills.map((skill) => skill.key)).size === skills.length
          ? undefined
          : "Managed skill keys must be unique within a release.",
      ),
      Schema.makeFilter<readonly (typeof ManagedSkillReleaseEntry.Type)[]>((skills) =>
        new TextEncoder().encode(JSON.stringify(skills)).byteLength <= 3 * 1024 * 1024
          ? undefined
          : "Managed skill release content must not exceed 3145728 encoded bytes.",
      ),
    ),
  ),
});

export const InstallManagedSkillRequest = Schema.Struct({
  agentDefinitionId: Schema.optional(PublicId),
  managedSkillId: PublicId,
  managedSkillReleaseId: PublicId,
});

export const ManagedSkillSourceResponse = Schema.Struct({
  createdAt: Timestamp,
  id: PublicId,
  key: SkillKey,
  licenseHash: Schema.optional(CanonicalHash),
  metadata: Schema.optional(Metadata),
  name: ResourceName,
  pinnedCommit: Schema.optional(Schema.String),
  repositoryUrl: Schema.optional(RepositoryUrl),
  status: Schema.Literals(["active", "archived"]),
  updatedAt: Timestamp,
  version: ResourceVersion,
});

export const ManagedSkillReleaseResponse = Schema.Struct({
  activatedAt: Schema.optional(Timestamp),
  archivedAt: Schema.optional(Timestamp),
  contentHash: CanonicalHash,
  createdAt: Timestamp,
  id: PublicId,
  manifest: Metadata,
  releaseVersion: Schema.String,
  skillCount: Schema.Number.pipe(Schema.check(Schema.isInt(), Schema.isGreaterThan(0))),
  sourceId: PublicId,
  status: Schema.Literals(["active", "archived"]),
  version: ResourceVersion,
});

export const ManagedSkillResponse = Schema.Struct({
  content: ManagedSkillContent,
  createdAt: Timestamp,
  dependencies: Schema.Array(PublicId),
  description: Schema.optional(ResourceDescription),
  id: PublicId,
  key: SkillKey,
  metadata: Schema.optional(Metadata),
  referencePaths: Schema.Array(ManagedSkillReferencePath),
  releaseId: PublicId,
  sourceId: PublicId,
});

export const ManagedSkillInstallationResponse = Schema.Struct({
  agentDefinitionId: Schema.optional(PublicId),
  createdAt: Timestamp,
  environmentId: PublicId,
  id: PublicId,
  installedByPrincipalId: PublicId,
  managedSkillId: PublicId,
  managedSkillReleaseId: PublicId,
  organizationId: PublicId,
  projectId: PublicId,
  status: Schema.Literals(["active", "removed", "superseded"]),
  updatedAt: Timestamp,
  version: ResourceVersion,
});

export const ListManagedSkillSourcesResponse = Schema.Struct({
  items: Schema.Array(ManagedSkillSourceResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});
export const ListManagedSkillReleasesResponse = Schema.Struct({
  items: Schema.Array(ManagedSkillReleaseResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});
export const ListManagedSkillsResponse = Schema.Struct({
  items: Schema.Array(ManagedSkillResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});
export const ListManagedSkillInstallationsResponse = Schema.Struct({
  items: Schema.Array(ManagedSkillInstallationResponse),
  nextCursor: Schema.optional(Schema.NullOr(Cursor)),
});

export type CreateManagedSkillSourceRequest = typeof CreateManagedSkillSourceRequest.Type;
export type UpdateManagedSkillSourceRequest = typeof UpdateManagedSkillSourceRequest.Type;
export type ArchiveManagedSkillResourceRequest = typeof ArchiveManagedSkillResourceRequest.Type;
export type PublishManagedSkillReleaseRequest = typeof PublishManagedSkillReleaseRequest.Type;
export type InstallManagedSkillRequest = typeof InstallManagedSkillRequest.Type;
export type ManagedSkillSourceResponse = typeof ManagedSkillSourceResponse.Type;
export type ManagedSkillReleaseResponse = typeof ManagedSkillReleaseResponse.Type;
export type ManagedSkillResponse = typeof ManagedSkillResponse.Type;
export type ManagedSkillInstallationResponse = typeof ManagedSkillInstallationResponse.Type;
