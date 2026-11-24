import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  Metadata,
  NonNegativeSafeInteger,
  Timestamp,
  makeRecordSchema,
  stateVersionFields,
  tenantScopeFields,
} from "../record-schema.ts";

export const HOSTED_CODE_CONTENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export const HOSTED_CODE_MAX_ARTIFACT_BYTES = 1024 * 1024;

export const HostedCodeContentHash = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(HOSTED_CODE_CONTENT_HASH_PATTERN, {
      message: "Hosted code content hashes must be sha256:<64 lowercase hex characters>.",
    }),
  ),
);
const ArtifactByteSize = NonNegativeSafeInteger.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: HOSTED_CODE_MAX_ARTIFACT_BYTES })),
);
export const HostedCodeRuntimeLanguage = Schema.Literals(["javascript", "python"]);
export const HostedCodeSourceLanguage = Schema.Literals(["javascript", "python", "typescript"]);

/** Immutable, versioned S3 object holding the executable artifact bytes. */
export const HostedCodeArtifactStorage = Schema.Struct({
  bucket: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  byteSize: ArtifactByteSize,
  key: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  versionId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});

function organizationScopedStorage(
  organizationId: string,
  storage: typeof HostedCodeArtifactStorage.Type,
) {
  return storage.key.startsWith(`organizations/${organizationId}/hosted-code-artifacts/`)
    ? undefined
    : "Hosted code artifacts must be stored under their organization prefix.";
}

/**
 * Content-addressed executable code. The canonical sort key is the content hash, so a create-only
 * put is the uniqueness guarantee and the record never changes after it is written.
 */
const HostedCodeArtifactRecordBase = makeRecordSchema("hosted-code-artifact", {
  ...stateVersionFields,
  ...tenantScopeFields,
  byteSize: ArtifactByteSize,
  contentHash: HostedCodeContentHash,
  createdAt: Timestamp,
  createdByPrincipalId: Ulid,
  language: HostedCodeRuntimeLanguage,
  sourceByteSize: ArtifactByteSize,
  sourceContentHash: HostedCodeContentHash,
  sourceLanguage: HostedCodeSourceLanguage,
  storage: HostedCodeArtifactStorage,
});

export const HostedCodeArtifactRecord = HostedCodeArtifactRecordBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof HostedCodeArtifactRecordBase.Type>((record) => {
      if (record.data.version !== 0) return "Hosted code artifacts are immutable.";
      if (record.data.storage.byteSize !== record.data.byteSize) {
        return "Hosted code artifact storage size must match the artifact size.";
      }
      if ((record.data.sourceLanguage === "python") !== (record.data.language === "python")) {
        return "Hosted code source and runtime languages are inconsistent.";
      }
      return organizationScopedStorage(record.data.organizationId, record.data.storage);
    }),
  ),
);

export const HostedCodeNetworkMode = Schema.Literals(["none", "sandbox"]);
export const HostedCodeEntrypoint = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u)),
);

/** Exact code, contract, and limits of one hosted code tool, captured when a pin is written. */
const hostedCodeToolPinFields = {
  ...stateVersionFields,
  ...tenantScopeFields,
  artifact: HostedCodeArtifactStorage,
  contentHash: HostedCodeContentHash,
  createdAt: Timestamp,
  effect: Schema.Literals(["execute", "read", "write"]),
  entrypoint: HostedCodeEntrypoint,
  inputSchema: Metadata,
  language: HostedCodeRuntimeLanguage,
  memoryMiB: NonNegativeSafeInteger,
  network: HostedCodeNetworkMode,
  outputSchema: Metadata,
  secretNames: Schema.Array(Schema.String),
  sourceLanguage: HostedCodeSourceLanguage,
  timeoutMs: NonNegativeSafeInteger,
  toolAdapterId: Ulid,
  toolAdapterVersion: NonNegativeSafeInteger,
  toolName: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
};

/**
 * Release-time snapshot of one hosted code tool. Written in the release publish transaction and
 * never updated, so a published release always executes exactly this code and contract.
 */
const AgentReleaseHostedCodeToolRecordBase = makeRecordSchema("agent-release-hosted-code-tool", {
  ...hostedCodeToolPinFields,
  agentReleaseId: Ulid,
});

export const AgentReleaseHostedCodeToolRecord = AgentReleaseHostedCodeToolRecordBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof AgentReleaseHostedCodeToolRecordBase.Type>((record) =>
      record.data.version !== 0
        ? "Release hosted code tool pins are immutable."
        : organizationScopedStorage(record.data.organizationId, record.data.artifact),
    ),
  ),
);

/**
 * Binding-time snapshot of one hosted code tool for a manifest-sourced execution binding. Written
 * with the binding and never updated; it expires with the binding.
 */
const ExecutionBindingHostedCodeToolRecordBase = makeRecordSchema(
  "execution-binding-hosted-code-tool",
  {
    ...hostedCodeToolPinFields,
    executionBindingId: Ulid,
    expiresAt: Timestamp,
  },
  { expiresAtField: "expiresAt" },
);

export const ExecutionBindingHostedCodeToolRecord = ExecutionBindingHostedCodeToolRecordBase.pipe(
  Schema.check(
    Schema.makeFilter<typeof ExecutionBindingHostedCodeToolRecordBase.Type>((record) =>
      record.data.version !== 0
        ? "Execution binding hosted code tool pins are immutable."
        : organizationScopedStorage(record.data.organizationId, record.data.artifact),
    ),
  ),
);
