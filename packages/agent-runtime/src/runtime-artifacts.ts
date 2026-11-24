/* eslint-disable no-await-in-loop -- Artifact identities and callbacks are ordered by index. */

import { RuntimeArtifactPublicationError, RuntimeArtifactValidationError } from "./errors.ts";
import { boundedRuntimeError } from "./redaction.ts";
import { MAX_CAPTURE_COUNT, MAX_TOTAL_CAPTURE_BYTES, progressContext } from "./runtime-core.ts";
import type { RuntimeExecutionState } from "./runtime-core.ts";
import type {
  AgentRunInput,
  AgentRuntimeDependencies,
  RuntimeArtifact,
  RuntimeArtifactContinuation,
} from "./types.ts";

const MAX_ARTIFACT_FILE_NAME_BYTES = 240;
const MAX_ARTIFACT_LABEL_BYTES = 512;
const MAX_ARTIFACT_CONTENT_TYPE_BYTES = 256;
const MAX_ARTIFACT_TYPE_BYTES = 128;
const MAX_CONTINUATION_METADATA_BYTES = 32 * 1024;
export const MAX_SANDBOX_FAILURE_MESSAGE_BYTES = 2 * 1024;

export interface RecordArtifactsOptions {
  readonly continueAfterPersistedPublicationFailure?: boolean;
}

function canonicalUtf8(value: string): string {
  return new TextDecoder("utf-8").decode(new TextEncoder().encode(value));
}

function canonicalArtifactFileName(value: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeArtifactValidationError(
      "Runtime artifact fileName must be a non-empty string.",
    );
  }
  const normalized = canonicalUtf8(value).trim();
  let fileName = "";
  for (const character of normalized) {
    const codePoint = character.codePointAt(0)!;
    const safe =
      character === "/" || character === "\\" || codePoint <= 0x1f || codePoint === 0x7f
        ? "-"
        : character;
    if (new TextEncoder().encode(fileName + safe).byteLength > MAX_ARTIFACT_FILE_NAME_BYTES) break;
    fileName += safe;
  }
  if (!fileName || fileName === "." || fileName === "..") {
    throw new RuntimeArtifactValidationError("Runtime artifact fileName is invalid.");
  }
  return fileName;
}

export function boundedSandboxFailureMessage(parts: readonly string[]): string {
  const value = parts.join(" ");
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= MAX_SANDBOX_FAILURE_MESSAGE_BYTES) return value;
  const suffix = "...";
  const maximumPrefixBytes = MAX_SANDBOX_FAILURE_MESSAGE_BYTES - suffix.length;
  let bytes = 0;
  let prefix = "";
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength;
    if (bytes + characterBytes > maximumPrefixBytes) break;
    prefix += character;
    bytes += characterBytes;
  }
  return `${prefix}${suffix}`;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RuntimeArtifactValidationError(`${label} must be an object.`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function boundedText(value: unknown, label: string, maximumBytes: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeArtifactValidationError(`${label} must be a non-empty string.`);
  }
  const normalized = canonicalUtf8(value);
  if (new TextEncoder().encode(normalized).byteLength > maximumBytes) {
    throw new RuntimeArtifactValidationError(`${label} exceeds ${maximumBytes} UTF-8 bytes.`);
  }
  return normalized;
}

function optionalBoundedText(
  value: unknown,
  label: string,
  maximumBytes: number,
): string | undefined {
  if (value === undefined) return undefined;
  return boundedText(value, label, maximumBytes);
}

function artifactVisibility(value: unknown): RuntimeArtifact["visibility"] {
  if (
    value === undefined ||
    value === "organization" ||
    value === "private" ||
    value === "public"
  ) {
    return value;
  }
  throw new RuntimeArtifactValidationError("Runtime artifact visibility is invalid.");
}

export function runtimeArtifactSummary(artifact: RuntimeArtifact) {
  const fileName = canonicalArtifactFileName(artifact.fileName);
  const label = boundedText(
    artifact.label,
    "Runtime artifact label",
    MAX_ARTIFACT_LABEL_BYTES,
  ).trim();
  const visibility = artifactVisibility(artifact.visibility);
  return {
    contentType:
      optionalBoundedText(
        artifact.contentType,
        "Runtime artifact contentType",
        MAX_ARTIFACT_CONTENT_TYPE_BYTES,
      )?.trim() || "application/octet-stream",
    fileName,
    label: label || fileName,
    type:
      optionalBoundedText(
        artifact.type,
        "Runtime artifact type",
        MAX_ARTIFACT_TYPE_BYTES,
      )?.trim() || "report",
    ...(visibility ? { visibility } : {}),
  };
}

function visibilityRank(visibility: RuntimeArtifact["visibility"]) {
  return visibility === "private" ? 0 : visibility === "public" ? 2 : 1;
}

function canonicalRuntimeArtifact(artifact: RuntimeArtifact): RuntimeArtifact {
  const summary = runtimeArtifactSummary(artifact);
  return {
    content:
      typeof artifact.content === "string" ? canonicalUtf8(artifact.content) : artifact.content,
    contentType: summary.contentType,
    fileName: summary.fileName,
    label: summary.label,
    ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
    type: summary.type,
    ...(summary.visibility ? { visibility: summary.visibility } : {}),
  };
}

function continuationMetadataBytes(artifacts: RuntimeArtifactContinuation["artifacts"]): number {
  return artifacts.reduce(
    (total, artifact) =>
      total +
      new TextEncoder().encode(
        JSON.stringify({
          contentType: artifact.contentType ?? null,
          fileName: artifact.fileName,
          label: artifact.label,
          type: artifact.type ?? null,
          visibility: artifact.visibility ?? null,
        }),
      ).byteLength,
    0,
  );
}

export function validateRuntimeArtifactContinuation(value: unknown): RuntimeArtifactContinuation {
  const continuation = record(value, "Runtime artifact continuation");
  if (!Array.isArray(continuation.artifacts)) {
    throw new RuntimeArtifactValidationError(
      "Runtime artifact continuation artifacts must be an array.",
    );
  }
  if (continuation.artifacts.length > MAX_CAPTURE_COUNT) {
    throw new RuntimeArtifactValidationError(
      `Runtime artifact continuation exceeds ${MAX_CAPTURE_COUNT} artifacts.`,
    );
  }
  const artifacts = continuation.artifacts.map((value, index) => {
    const artifact = record(value, `Runtime artifact continuation artifacts[${index}]`);
    return runtimeArtifactSummary({
      content: "",
      ...(artifact.contentType !== undefined
        ? { contentType: artifact.contentType as string }
        : {}),
      fileName: artifact.fileName as string,
      label: artifact.label as string,
      ...(artifact.type !== undefined ? { type: artifact.type as string } : {}),
      ...(artifact.visibility !== undefined
        ? {
            visibility: artifact.visibility as Exclude<RuntimeArtifact["visibility"], undefined>,
          }
        : {}),
    });
  });
  if (continuationMetadataBytes(artifacts) > MAX_CONTINUATION_METADATA_BYTES) {
    throw new RuntimeArtifactValidationError(
      `Runtime artifact continuation metadata exceeds ${MAX_CONTINUATION_METADATA_BYTES} bytes.`,
    );
  }
  const artifactIndexCursor = continuation.artifactIndexCursor;
  const artifactBytes = continuation.artifactBytes;
  if (
    !Number.isSafeInteger(artifactIndexCursor) ||
    Number(artifactIndexCursor) !== artifacts.length ||
    Number(artifactIndexCursor) > MAX_CAPTURE_COUNT ||
    !Number.isSafeInteger(artifactBytes) ||
    Number(artifactBytes) < 0 ||
    Number(artifactBytes) > MAX_TOTAL_CAPTURE_BYTES
  ) {
    throw new RuntimeArtifactValidationError("Runtime artifact continuation counters are invalid.");
  }
  if (
    continuation.sandboxCompleted !== undefined &&
    typeof continuation.sandboxCompleted !== "boolean"
  ) {
    throw new RuntimeArtifactValidationError(
      "Runtime artifact continuation sandboxCompleted must be a boolean.",
    );
  }
  const sandboxFailureMessage = optionalBoundedText(
    continuation.sandboxFailureMessage,
    "Runtime artifact continuation sandboxFailureMessage",
    MAX_SANDBOX_FAILURE_MESSAGE_BYTES,
  );
  if (sandboxFailureMessage && continuation.sandboxCompleted !== true) {
    throw new RuntimeArtifactValidationError(
      "Runtime artifact continuation sandboxFailureMessage requires sandboxCompleted.",
    );
  }
  const pendingArtifactPublicationIndexes = continuation.pendingArtifactPublicationIndexes;
  if (
    pendingArtifactPublicationIndexes !== undefined &&
    (!Array.isArray(pendingArtifactPublicationIndexes) ||
      pendingArtifactPublicationIndexes.some(
        (index) =>
          !Number.isSafeInteger(index) ||
          Number(index) < 0 ||
          Number(index) >= Number(artifactIndexCursor),
      ) ||
      new Set(pendingArtifactPublicationIndexes).size !== pendingArtifactPublicationIndexes.length)
  ) {
    throw new RuntimeArtifactValidationError(
      "Runtime artifact continuation pending publication indexes are invalid.",
    );
  }
  return {
    artifactBytes: Number(artifactBytes),
    artifactIndexCursor: Number(artifactIndexCursor),
    artifacts,
    ...(pendingArtifactPublicationIndexes && pendingArtifactPublicationIndexes.length > 0
      ? { pendingArtifactPublicationIndexes: pendingArtifactPublicationIndexes.map(Number) }
      : {}),
    ...(continuation.sandboxCompleted === true ? { sandboxCompleted: true } : {}),
    ...(sandboxFailureMessage ? { sandboxFailureMessage } : {}),
  };
}

export function artifactContinuation(state: RuntimeExecutionState): RuntimeArtifactContinuation {
  return validateRuntimeArtifactContinuation({
    artifactBytes: state.artifactBytes,
    artifactIndexCursor: state.artifactIndexCursor,
    artifacts: state.artifacts.map(runtimeArtifactSummary),
    ...(state.pendingArtifactPublicationIndexes.length > 0
      ? { pendingArtifactPublicationIndexes: state.pendingArtifactPublicationIndexes }
      : {}),
    ...(state.sandboxCompleted ? { sandboxCompleted: true } : {}),
    ...(state.sandboxFailureMessage ? { sandboxFailureMessage: state.sandboxFailureMessage } : {}),
  });
}

export async function retryPendingArtifactPublications(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
  state: RuntimeExecutionState,
): Promise<void> {
  if (state.pendingArtifactPublicationIndexes.length === 0) return;
  if (!dependencies.retryArtifactPublication) {
    throw new RuntimeArtifactValidationError(
      "Pending artifact publications require a retryArtifactPublication port.",
    );
  }
  for (const index of state.pendingArtifactPublicationIndexes) {
    try {
      await dependencies.retryArtifactPublication(index, progressContext(input));
    } catch (cause) {
      if (cause instanceof RuntimeArtifactPublicationError) throw cause;
      throw new RuntimeArtifactPublicationError(
        boundedRuntimeError(cause, "Runtime artifact publication retry failed."),
        { artifactPersisted: true, cause },
      );
    }
    state.pendingArtifactPublicationIndexes.splice(
      state.pendingArtifactPublicationIndexes.indexOf(index),
      1,
    );
  }
}

export function continuedArtifacts(
  continuation: RuntimeArtifactContinuation | undefined,
): RuntimeArtifact[] {
  return (continuation?.artifacts ?? []).map((artifact) => ({
    // Continuations intentionally carry bounded evidence metadata, not persisted artifact bodies.
    content: `Previously recorded artifact: ${artifact.label} (${artifact.fileName})`,
    ...(artifact.contentType ? { contentType: artifact.contentType } : {}),
    fileName: artifact.fileName,
    label: artifact.label,
    metadata: { continued: true },
    ...(artifact.type ? { type: artifact.type } : {}),
    ...(artifact.visibility ? { visibility: artifact.visibility } : {}),
  }));
}

export async function rehydrateContinuedArtifacts(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
  continuation: RuntimeArtifactContinuation | undefined,
): Promise<RuntimeArtifact[] | undefined> {
  if (!continuation || continuation.artifacts.length === 0) return undefined;
  if (!dependencies.loadArtifact) {
    throw new RuntimeArtifactValidationError(
      "Continued artifacts require a loadArtifact port before runtime execution can resume.",
    );
  }
  const loaded: RuntimeArtifact[] = [];
  try {
    for (const [index, expected] of continuation.artifacts.entries()) {
      const artifact = await dependencies.loadArtifact(index, progressContext(input));
      const actual = runtimeArtifactSummary(artifact);
      if (
        actual.fileName !== expected.fileName ||
        actual.label !== expected.label ||
        (expected.contentType !== undefined && actual.contentType !== expected.contentType) ||
        (expected.type !== undefined && actual.type !== expected.type) ||
        visibilityRank(actual.visibility) < visibilityRank(expected.visibility)
      ) {
        throw new RuntimeArtifactValidationError(
          `Persisted artifact ${index} does not match its continuation metadata.`,
        );
      }
      loaded.push({
        content: artifact.content,
        ...(expected.contentType !== undefined ? { contentType: expected.contentType } : {}),
        fileName: expected.fileName,
        label: expected.label,
        ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
        ...(expected.type !== undefined ? { type: expected.type } : {}),
        ...(artifact.visibility ? { visibility: artifact.visibility } : {}),
      });
    }
  } catch (cause) {
    if (
      cause instanceof RuntimeArtifactPublicationError ||
      cause instanceof RuntimeArtifactValidationError
    ) {
      throw cause;
    }
    throw new RuntimeArtifactPublicationError(
      boundedRuntimeError(cause, "Persisted runtime artifact loading failed."),
      { artifactPersisted: true, cause },
    );
  }
  const loadedBytes = loaded.reduce(
    (total, artifact) =>
      total +
      (typeof artifact.content === "string"
        ? Buffer.byteLength(artifact.content, "utf8")
        : artifact.content.byteLength),
    0,
  );
  if (loadedBytes !== continuation.artifactBytes) {
    throw new RuntimeArtifactValidationError(
      "Persisted artifact bodies do not match the continuation byte count.",
    );
  }
  return loaded;
}

export async function recordArtifacts(
  input: AgentRunInput,
  dependencies: AgentRuntimeDependencies,
  artifacts: readonly RuntimeArtifact[],
  indexOffset = 0,
  onRecorded?: (artifact: RuntimeArtifact, index: number, publicationPending: boolean) => void,
  options: RecordArtifactsOptions = {},
): Promise<void> {
  if (artifacts.length > 0 && !dependencies.recordArtifact) {
    throw new RuntimeArtifactValidationError(
      "Runtime artifact persistence requires a recordArtifact port.",
    );
  }
  let deferredPublicationError: RuntimeArtifactPublicationError | undefined;
  for (const [index, artifact] of artifacts.entries()) {
    const canonicalArtifact = canonicalRuntimeArtifact(artifact);
    try {
      await dependencies.recordArtifact!(
        canonicalArtifact,
        indexOffset + index,
        progressContext(input),
      );
    } catch (cause) {
      if (cause instanceof RuntimeArtifactPublicationError) {
        if (cause.artifactPersisted) {
          onRecorded?.(canonicalArtifact, indexOffset + index, true);
          if (options.continueAfterPersistedPublicationFailure) {
            deferredPublicationError ??= cause;
            continue;
          }
        }
        throw cause;
      }
      if (cause instanceof RuntimeArtifactValidationError) {
        throw cause;
      }
      throw new RuntimeArtifactPublicationError(
        boundedRuntimeError(cause, "Runtime artifact publication failed."),
        { cause },
      );
    }
    onRecorded?.(canonicalArtifact, indexOffset + index, false);
  }
  if (deferredPublicationError) throw deferredPublicationError;
}
