import {
  ProviderMutationClaimRecord,
  canonicalRecordKeys,
  key,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
  workerPersistence,
} from "@deployments-ai/db";
import {
  boundedRuntimeError,
  RuntimeToolPreparationRetryableError,
  type RuntimeArtifact,
  type RuntimeToolExecutionBinding,
  type RuntimeToolExecutionResult,
} from "@deployments-ai/agent-runtime";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Schema } from "effect";

type ProviderMutationClaimRecordValue = Extract<
  PlatformRecord,
  { readonly itemType: "provider-mutation-claim" }
>;

export interface RuntimeProviderMutationClaimInput {
  readonly binding: RuntimeToolExecutionBinding;
  readonly effect: "execute" | "write";
  readonly environmentId: Ulid;
  readonly idempotencyKey: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly runId: Ulid;
  readonly threadId: Ulid;
  readonly toolCallId: Ulid;
  readonly toolName: string;
}

export interface RuntimeProviderMutationClaim {
  readonly input: RuntimeProviderMutationClaimInput;
  readonly record: ProviderMutationClaimRecordValue;
}

export type RuntimeProviderMutationClaimStart =
  | { readonly action: "execute"; readonly claim: RuntimeProviderMutationClaim }
  | { readonly action: "replay"; readonly result: RuntimeToolExecutionResult };

export interface RuntimeProviderMutationClaimStore {
  readonly begin: (
    input: RuntimeProviderMutationClaimInput,
  ) => Promise<RuntimeProviderMutationClaimStart>;
  readonly fail: (claim: RuntimeProviderMutationClaim, cause: unknown) => Promise<void>;
  readonly markUnknown: (claim: RuntimeProviderMutationClaim, cause: unknown) => Promise<void>;
  readonly release: (claim: RuntimeProviderMutationClaim) => Promise<void>;
  readonly succeed: (
    claim: RuntimeProviderMutationClaim,
    result: RuntimeToolExecutionResult,
  ) => Promise<void>;
}

export class RuntimeProviderMutationKnownFailureError extends Error {
  constructor(
    readonly toolName: string,
    readonly persistedReason: string,
  ) {
    super(`Provider mutation ${toolName} previously failed: ${persistedReason}`);
    this.name = "RuntimeProviderMutationKnownFailureError";
  }
}

export class RuntimeProviderMutationOutcomeUnknownError extends Error {
  constructor(
    readonly toolName: string,
    options?: ErrorOptions,
  ) {
    super(`Provider mutation ${toolName} has an unresolved prior dispatch.`, options);
    this.name = "RuntimeProviderMutationOutcomeUnknownError";
  }
}

export class RuntimeProviderMutationIdentityConflictError extends Error {
  constructor(readonly toolName: string) {
    super(`Provider mutation claim identity does not match the ${toolName} runtime request.`);
    this.name = "RuntimeProviderMutationIdentityConflictError";
  }
}

const MAX_PERSISTED_RESULT_BYTES = 300 * 1024;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, child]) => [name, stableValue(child)]),
    );
  }
  return value;
}

function canonicalJsonValue(value: unknown, label: string): unknown {
  try {
    const serialized = JSON.stringify(stableValue(value));
    if (serialized === undefined) throw new Error("value was omitted");
    return JSON.parse(serialized) as unknown;
  } catch (cause) {
    throw new Error(`${label} must be JSON-compatible.`, { cause });
  }
}

function immutableIdentityHash(input: RuntimeProviderMutationClaimInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        stableValue({
          authorizationFingerprint: input.binding.authorizationFingerprint,
          connectionId: input.binding.connectionId,
          effect: input.effect,
          environmentId: input.environmentId,
          externalAccountId: input.binding.externalAccountId,
          idempotencyKey: input.idempotencyKey,
          input: input.input ?? null,
          operation: input.toolName,
          organizationId: input.organizationId,
          projectId: input.projectId,
          runId: input.runId,
        }),
      ),
    )
    .digest("hex");
}

function claimKey(
  input: Pick<
    RuntimeProviderMutationClaimInput,
    "environmentId" | "idempotencyKey" | "organizationId" | "runId"
  >,
) {
  const { pk, sk } = canonicalRecordKeys(
    {
      data: {
        environmentId: input.environmentId,
        idempotencyKey: input.idempotencyKey,
        organizationId: input.organizationId,
        runId: input.runId,
      },
      itemType: "provider-mutation-claim",
    },
    "execution",
  );
  return { pk, sk };
}

function legacyClaimKey(
  input: Pick<
    RuntimeProviderMutationClaimInput,
    "environmentId" | "idempotencyKey" | "organizationId"
  >,
) {
  return {
    pk: key("ORG", input.organizationId, "ENV", input.environmentId),
    sk: key("PROVIDER-MUTATION-CLAIM", input.idempotencyKey),
  };
}

function isLegacyClaimRecord(record: ProviderMutationClaimRecordValue) {
  const legacy = legacyClaimKey(record.data);
  return record.pk === legacy.pk && record.sk === legacy.sk;
}

async function loadClaimAtKey(
  database: DynamoDatabaseService,
  recordKey: { readonly pk: string; readonly sk: string },
): Promise<ProviderMutationClaimRecordValue | undefined> {
  const result = await workerPersistence.read(database, "execution", recordKey, true);
  const record = result;
  if (!record) return undefined;
  if (record.itemType !== "provider-mutation-claim") {
    throw new Error("Provider mutation claim key resolved to an unexpected record type.");
  }
  return record;
}

async function loadClaimByKey(
  database: DynamoDatabaseService,
  input: Pick<
    RuntimeProviderMutationClaimInput,
    "environmentId" | "idempotencyKey" | "organizationId" | "runId"
  >,
): Promise<ProviderMutationClaimRecordValue | undefined> {
  const canonical = await loadClaimAtKey(database, claimKey(input));
  if (canonical) return canonical;
  const legacy = await loadClaimAtKey(database, legacyClaimKey(input));
  return legacy?.data.runId === input.runId ? legacy : undefined;
}

const loadClaim = loadClaimByKey;

function assertClaimIdentity(
  claim: ProviderMutationClaimRecordValue,
  input: RuntimeProviderMutationClaimInput,
): void {
  if (
    claim.data.organizationId !== input.organizationId ||
    claim.data.projectId !== input.projectId ||
    claim.data.environmentId !== input.environmentId ||
    claim.data.connectionId !== input.binding.connectionId ||
    claim.data.runId !== input.runId ||
    claim.data.operation !== input.toolName ||
    claim.data.idempotencyKey !== input.idempotencyKey ||
    claim.data.immutableIdentityHash !== immutableIdentityHash(input)
  ) {
    throw new RuntimeProviderMutationIdentityConflictError(input.toolName);
  }
}

function artifactDocument(artifact: RuntimeArtifact) {
  return {
    content:
      typeof artifact.content === "string"
        ? artifact.content
        : Buffer.from(artifact.content).toString("base64"),
    contentEncoding: typeof artifact.content === "string" ? "utf8" : "base64",
    ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
    fileName: artifact.fileName,
    label: artifact.label,
    ...(artifact.metadata
      ? { metadata: canonicalJsonValue(artifact.metadata, "Provider mutation artifact metadata") }
      : {}),
    ...(artifact.type ? { type: artifact.type } : {}),
    ...(artifact.visibility ? { visibility: artifact.visibility } : {}),
  };
}

function persistedResult(result: RuntimeToolExecutionResult): Readonly<Record<string, unknown>> {
  // A `running` result is a dispatched mutation whose outcome resolves later through its
  // external operation (an awaited sub-agent run); replay must return the same pending handle.
  if (result.status === "running" && !result.externalOperationId) {
    throw new Error(
      "Provider mutation claims can persist a running result only with its operation.",
    );
  }
  const document = canonicalJsonValue(
    {
      artifacts: (result.artifacts ?? []).map(artifactDocument),
      ...(result.externalOperationId ? { externalOperationId: result.externalOperationId } : {}),
      kind: "runtime-tool-result-v1",
      ...(result.output
        ? { output: canonicalJsonValue(result.output, "Provider mutation output") }
        : {}),
      ...(result.outputSummary ? { outputSummary: result.outputSummary } : {}),
      status: result.status,
    },
    "Provider mutation result",
  ) as Readonly<Record<string, unknown>>;
  if (new TextEncoder().encode(JSON.stringify(document)).byteLength > MAX_PERSISTED_RESULT_BYTES) {
    throw new Error(
      `Provider mutation result exceeds the ${MAX_PERSISTED_RESULT_BYTES}-byte persistence limit.`,
    );
  }
  return document;
}

function requiredString(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Persisted provider mutation result is missing ${field}.`);
  }
  return value;
}

function replayArtifact(value: unknown): RuntimeArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted provider mutation artifact is invalid.");
  }
  const record = value as Readonly<Record<string, unknown>>;
  const encoding = requiredString(record, "contentEncoding");
  const content = requiredString(record, "content");
  if (encoding !== "utf8" && encoding !== "base64") {
    throw new Error("Persisted provider mutation artifact encoding is invalid.");
  }
  const fileName = requiredString(record, "fileName");
  const metadata =
    record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
      ? (record.metadata as Readonly<Record<string, unknown>>)
      : undefined;
  return {
    content: encoding === "utf8" ? content : Uint8Array.from(Buffer.from(content, "base64")),
    ...(typeof record.contentType === "string" ? { contentType: record.contentType } : {}),
    fileName,
    label: requiredString(record, "label"),
    ...(metadata ? { metadata } : {}),
    ...(typeof record.type === "string" ? { type: record.type } : {}),
    ...(record.visibility === "organization" ||
    record.visibility === "private" ||
    record.visibility === "public"
      ? { visibility: record.visibility }
      : {}),
  };
}

function replayResult(value: unknown): RuntimeToolExecutionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted provider mutation result is invalid.");
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (
    record.kind !== "runtime-tool-result-v1" ||
    (record.status !== "completed" && record.status !== "running")
  ) {
    throw new Error("Persisted provider mutation result version is not supported.");
  }
  if (!Array.isArray(record.artifacts)) {
    throw new Error("Persisted provider mutation artifacts are invalid.");
  }
  if (
    record.output !== undefined &&
    (!record.output || typeof record.output !== "object" || Array.isArray(record.output))
  ) {
    throw new Error("Persisted provider mutation output is invalid.");
  }
  return {
    artifacts: record.artifacts.map(replayArtifact),
    ...(typeof record.externalOperationId === "string"
      ? { externalOperationId: record.externalOperationId }
      : {}),
    ...(record.output ? { output: record.output as Readonly<Record<string, unknown>> } : {}),
    ...(typeof record.outputSummary === "string" ? { outputSummary: record.outputSummary } : {}),
    status: record.status,
  };
}

function failureReason(claim: ProviderMutationClaimRecordValue): string {
  const error = claim.data.externalResult?.error;
  return typeof error === "string" && error.trim()
    ? error.trim()
    : "Provider mutation failed before a terminal run commit.";
}

function activeClaim(input: RuntimeProviderMutationClaimInput, now: string) {
  return Schema.decodeUnknownSync(ProviderMutationClaimRecord)(
    withCanonicalRecordKeys({
      itemType: "provider-mutation-claim" as const,
      data: {
        connectionId: input.binding.connectionId,
        claimAttemptId: randomUUID(),
        createdAt: now,
        environmentId: input.environmentId,
        id: input.toolCallId,
        idempotencyKey: input.idempotencyKey,
        immutableIdentityHash: immutableIdentityHash(input),
        operation: input.toolName,
        organizationId: input.organizationId,
        projectId: input.projectId,
        runId: input.runId,
        status: "active" as const,
        threadId: input.threadId,
        toolCallId: input.toolCallId,
        updatedAt: now,
        version: 0,
      },
    }),
  );
}

async function replaceClaim(
  database: DynamoDatabaseService,
  previous: ProviderMutationClaimRecordValue,
  status: ProviderMutationClaimRecordValue["data"]["status"],
  now: string,
  externalResult?: Readonly<Record<string, unknown>>,
): Promise<ProviderMutationClaimRecordValue> {
  const canonicalReplacement = Schema.decodeUnknownSync(ProviderMutationClaimRecord)(
    withCanonicalRecordKeys({
      itemType: "provider-mutation-claim" as const,
      data: {
        ...previous.data,
        ...(externalResult ? { externalResult } : {}),
        status,
        updatedAt: now,
        version: previous.data.version + 1,
      },
    }),
  );
  const replacement = isLegacyClaimRecord(previous)
    ? (() => {
        const {
          gsi1pk: _gsi1pk,
          gsi1sk: _gsi1sk,
          gsi2pk: _gsi2pk,
          gsi2sk: _gsi2sk,
          pk: _pk,
          sk: _sk,
          ...record
        } = canonicalReplacement;
        return Schema.decodeUnknownSync(ProviderMutationClaimRecord)({
          ...record,
          gsi2pk: key("ENV", previous.data.environmentId),
          gsi2sk: key("PROVIDER-MUTATION-CLAIM", status, now, previous.data.idempotencyKey),
          pk: previous.pk,
          sk: previous.sk,
        });
      })()
    : canonicalReplacement;
  try {
    await workerPersistence.commit(database, [
      { kind: "put", previousRecord: previous, record: replacement },
    ]);
    return replacement;
  } catch (cause) {
    const observed = await loadClaimByKey(database, {
      environmentId: previous.data.environmentId,
      idempotencyKey: previous.data.idempotencyKey,
      organizationId: previous.data.organizationId,
      runId: previous.data.runId,
    });
    if (observed && isDeepStrictEqual(observed, replacement)) return observed;
    throw cause;
  }
}

export function createDynamoRuntimeProviderMutationClaimStore(
  database: DynamoDatabaseService,
  options: { readonly now?: () => Date } = {},
): RuntimeProviderMutationClaimStore {
  const now = () => (options.now?.() ?? new Date()).toISOString();

  const store: RuntimeProviderMutationClaimStore = {
    async begin(input) {
      let existing = await loadClaim(database, input);
      if (!existing) {
        const created = activeClaim(input, now());
        try {
          await workerPersistence.write(
            database,
            created,
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          );
          return { action: "execute", claim: { input, record: created } };
        } catch (cause) {
          existing = await loadClaim(database, input);
          if (!existing) throw cause;
          if (isDeepStrictEqual(existing, created)) {
            return { action: "execute", claim: { input, record: existing } };
          }
        }
      }

      assertClaimIdentity(existing, input);
      if (existing.data.status === "succeeded") {
        return {
          action: "replay",
          result: replayResult(existing.data.externalResult),
        };
      }
      if (existing.data.status === "failed") {
        throw new RuntimeProviderMutationKnownFailureError(input.toolName, failureReason(existing));
      }
      if (existing.data.status === "releasable") {
        try {
          await workerPersistence.commit(database, [{ kind: "delete", record: existing }]);
        } catch (cause) {
          const observed = await loadClaimByKey(database, input);
          if (!observed) return store.begin(input);
          throw new RuntimeToolPreparationRetryableError(input.toolName, cause);
        }
        return store.begin(input);
      }
      if (existing.data.status === "active") {
        try {
          await replaceClaim(database, existing, "unknown", now(), {
            error: "A prior worker stopped after acquiring the provider mutation claim.",
          });
        } catch (cause) {
          throw new RuntimeProviderMutationOutcomeUnknownError(input.toolName, { cause });
        }
      }
      throw new RuntimeProviderMutationOutcomeUnknownError(input.toolName);
    },

    async fail(claim, cause) {
      await replaceClaim(database, claim.record, "failed", now(), {
        error: boundedRuntimeError(cause, "Provider mutation failed."),
      });
    },

    async markUnknown(claim, cause) {
      await replaceClaim(database, claim.record, "unknown", now(), {
        error: boundedRuntimeError(cause, "Provider mutation outcome is unknown."),
      });
    },

    async release(claim) {
      try {
        await workerPersistence.commit(database, [{ kind: "delete", record: claim.record }]);
      } catch (cause) {
        const observed = await loadClaimByKey(database, claim.input);
        if (!observed) return;
        if (isDeepStrictEqual(observed, claim.record)) {
          try {
            await replaceClaim(database, observed, "releasable", now(), {
              error: "Provider dispatch did not start and claim release must be retried.",
            });
          } catch (transitionCause) {
            throw new AggregateError(
              [cause, transitionCause],
              "Claim release state update failed.",
            );
          }
        }
        throw cause;
      }
    },

    async succeed(claim, result) {
      await replaceClaim(database, claim.record, "succeeded", now(), persistedResult(result));
    },
  };
  return store;
}
