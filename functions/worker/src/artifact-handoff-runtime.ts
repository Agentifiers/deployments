import { createHash } from "node:crypto";
import type { DynamoValue, PlatformRecord, Ulid } from "@deployments-ai/db";
import {
  ARTIFACT_HANDOFF_CONTENT_TYPE_PLACEHOLDER,
  ARTIFACT_HANDOFF_FILE_NAME_PLACEHOLDER,
  ARTIFACT_HANDOFF_URL_PLACEHOLDER,
  findPlatformToolAdapterDefinition,
  PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY,
  providerNativeHttpToolDefinitions,
} from "@deployments-ai/tools";

type ToolCall = Extract<PlatformRecord, { readonly itemType: "tool-call" }>;
export interface ProviderHandoffSourceToolCall {
  readonly data: {
    readonly createdAt: string;
    readonly externalOperationId?: string | undefined;
    readonly id: Ulid;
    readonly input?: Readonly<Record<string, unknown>> | undefined;
    readonly outputSummary?: string | undefined;
    readonly status: ToolCall["data"]["status"];
    readonly toolName: string;
  };
}

export interface ProviderHandoffIntent {
  readonly [key: string]: DynamoValue;
  readonly accessExpiresInSeconds?: number;
  readonly artifactId: Ulid;
  readonly consumedAt?: string;
  readonly createdAt: string;
  readonly disposition?: "attachment" | "inline";
  readonly expiresAt?: string;
  readonly intentId: Ulid;
  readonly provider: string;
  readonly providerInputHash: string;
  readonly reservedAt?: string;
  readonly reservedByToolCallId?: Ulid;
  readonly sourceToolCallId?: Ulid;
  readonly toolName: string;
}

const MAX_PROVIDER_HANDOFF_INTENTS = 20;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    throw new TypeError("Provider handoff input must contain only JSON values.");
  }
  return `{${Object.keys(value)
    .toSorted()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

export function providerInputWithoutHandoff(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const providerInput = { ...input };
  delete providerInput[PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY];
  return providerInput;
}

export function providerHandoffInputHash(input: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function materializeProviderHandoffInput(
  input: Readonly<Record<string, unknown>>,
  artifact: { readonly contentType: string; readonly fileName: string; readonly url: string },
): Record<string, unknown> {
  let usedUrl = false;
  const replace = (value: unknown, depth: number): unknown => {
    if (depth > 20) throw new TypeError("providerInput exceeds the handoff nesting limit.");
    if (typeof value === "string") {
      if (value.includes(ARTIFACT_HANDOFF_URL_PLACEHOLDER)) usedUrl = true;
      return value
        .replaceAll(ARTIFACT_HANDOFF_URL_PLACEHOLDER, artifact.url)
        .replaceAll(ARTIFACT_HANDOFF_FILE_NAME_PLACEHOLDER, artifact.fileName)
        .replaceAll(ARTIFACT_HANDOFF_CONTENT_TYPE_PLACEHOLDER, artifact.contentType);
    }
    if (Array.isArray(value)) return value.map((entry) => replace(entry, depth + 1));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replace(entry, depth + 1)]),
    );
  };
  const materialized = replace(input, 0) as Record<string, unknown>;
  if (!usedUrl) {
    throw new TypeError("providerInput must contain {{artifact.url}} in a provider string field.");
  }
  return materialized;
}

function hasProviderHandoffUrlPlaceholder(input: unknown, depth = 0): boolean {
  if (depth > 20) throw new TypeError("providerInput exceeds the handoff nesting limit.");
  if (typeof input === "string") return input.includes(ARTIFACT_HANDOFF_URL_PLACEHOLDER);
  const values = Array.isArray(input)
    ? input
    : input && typeof input === "object"
      ? Object.values(input)
      : [];
  return values.some((value) => hasProviderHandoffUrlPlaceholder(value, depth + 1));
}

export function assertProviderHandoffInputTemplate(input: unknown): void {
  if (!hasProviderHandoffUrlPlaceholder(input)) {
    throw new TypeError("providerInput must contain {{artifact.url}} in a provider string field.");
  }
}

function stringField(value: Readonly<Record<string, unknown>>, name: string) {
  const field = value[name];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

export function providerHandoffIntents(value: unknown): ProviderHandoffIntent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Readonly<Record<string, unknown>>;
    const artifactId = stringField(record, "artifactId");
    const accessExpiresInSeconds = record.accessExpiresInSeconds;
    const createdAt = stringField(record, "createdAt");
    const expiresAt = stringField(record, "expiresAt");
    const intentId = stringField(record, "intentId");
    const provider = stringField(record, "provider");
    const providerInputHash = stringField(record, "providerInputHash");
    const reservedAt = stringField(record, "reservedAt");
    const reservedByToolCallId = stringField(record, "reservedByToolCallId");
    const toolName = stringField(record, "toolName");
    if (!artifactId || !createdAt || !intentId || !provider || !providerInputHash || !toolName) {
      return [];
    }
    const consumedAt = stringField(record, "consumedAt");
    const sourceToolCallId = stringField(record, "sourceToolCallId");
    const disposition = record.disposition;
    return [
      {
        ...(typeof accessExpiresInSeconds === "number" &&
        Number.isSafeInteger(accessExpiresInSeconds) &&
        accessExpiresInSeconds >= 60 &&
        accessExpiresInSeconds <= 3_600
          ? { accessExpiresInSeconds }
          : {}),
        artifactId: artifactId as Ulid,
        ...(consumedAt ? { consumedAt } : {}),
        createdAt,
        ...(disposition === "attachment" || disposition === "inline" ? { disposition } : {}),
        ...(expiresAt ? { expiresAt } : {}),
        intentId: intentId as Ulid,
        provider,
        providerInputHash,
        ...(reservedAt ? { reservedAt } : {}),
        ...(reservedByToolCallId ? { reservedByToolCallId: reservedByToolCallId as Ulid } : {}),
        ...(sourceToolCallId ? { sourceToolCallId: sourceToolCallId as Ulid } : {}),
        toolName,
      },
    ];
  });
}

export function appendProviderHandoffIntent(
  priorIntents: readonly ProviderHandoffIntent[],
  intent: ProviderHandoffIntent,
  timestamp: string,
): readonly ProviderHandoffIntent[] {
  const uniquePriorIntents = [
    ...new Map(
      priorIntents
        .filter((candidate) => candidate.intentId !== intent.intentId)
        .map((candidate) => [candidate.intentId, candidate] as const),
    ).values(),
  ];
  const activeIntents = uniquePriorIntents.filter((candidate) => {
    const expiresAt = Date.parse(candidate.expiresAt ?? "");
    return !candidate.consumedAt && Number.isFinite(expiresAt) && expiresAt > Date.parse(timestamp);
  });
  if (activeIntents.length >= MAX_PROVIDER_HANDOFF_INTENTS) {
    throw new TypeError(
      `Artifact has the maximum of ${MAX_PROVIDER_HANDOFF_INTENTS} active provider handoff intents.`,
    );
  }
  const activeIds = new Set(activeIntents.map((candidate) => candidate.intentId));
  const historySlots = MAX_PROVIDER_HANDOFF_INTENTS - activeIntents.length - 1;
  const history = uniquePriorIntents.filter((candidate) => !activeIds.has(candidate.intentId));
  return [...activeIntents, ...(historySlots > 0 ? history.slice(-historySlots) : []), intent];
}

export function assertProviderWriteTarget(provider: string, toolName: string) {
  const adapter = findPlatformToolAdapterDefinition(toolName);
  const nativeDefinition = providerNativeHttpToolDefinitions.find(
    (definition) => definition.toolName === toolName,
  );
  if (
    adapter?.status !== "active" ||
    adapter.provider !== provider ||
    adapter.effect !== "write" ||
    adapter.defaultPolicyAction !== "require_approval" ||
    !nativeDefinition ||
    nativeDefinition.effect !== "write" ||
    nativeDefinition.defaultPolicyAction !== "require_approval"
  ) {
    throw new TypeError("Provider handoff target must be an active canonical provider write tool.");
  }
  return { adapter, nativeDefinition };
}

export function assertSourceMatchesHandoffIntent(
  source: ProviderHandoffSourceToolCall,
  intent: ProviderHandoffIntent,
) {
  const input = source.data.input;
  const envelope = input?.[PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY];
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new TypeError("Source provider tool call is not bound to a handoff intent.");
  }
  const handoff = envelope as Readonly<Record<string, unknown>>;
  if (handoff.artifactId !== intent.artifactId || handoff.intentId !== intent.intentId) {
    throw new TypeError("Source provider tool call is bound to a different artifact handoff.");
  }
  if (
    source.data.toolName !== intent.toolName ||
    providerHandoffInputHash(providerInputWithoutHandoff(input)) !== intent.providerInputHash
  ) {
    throw new TypeError("Source provider tool call input does not match the handoff intent.");
  }
  if (intent.reservedByToolCallId !== source.data.id) {
    throw new TypeError("Source provider tool call does not own the handoff reservation.");
  }
  const sourceCreatedAt = Date.parse(source.data.createdAt);
  if (
    !Number.isFinite(sourceCreatedAt) ||
    sourceCreatedAt < Date.parse(intent.createdAt) ||
    (intent.expiresAt !== undefined && sourceCreatedAt > Date.parse(intent.expiresAt))
  ) {
    throw new TypeError("Source provider tool call was not created during the handoff window.");
  }
}

export function canonicalProviderHandoff(
  source: ProviderHandoffSourceToolCall,
  intent: ProviderHandoffIntent,
  recordedAt: string,
) {
  if (source.data.status !== "succeeded") {
    throw new TypeError("Source provider tool call has not succeeded.");
  }
  const { adapter, nativeDefinition } = assertProviderWriteTarget(intent.provider, intent.toolName);
  if (source.data.toolName !== intent.toolName) {
    throw new TypeError("Source provider tool call does not match toolName.");
  }
  return {
    ...(nativeDefinition.handoffResultStatus
      ? { artifactStatus: nativeDefinition.handoffResultStatus }
      : {}),
    ...(source.data.externalOperationId ? { externalId: source.data.externalOperationId } : {}),
    externalStatus: source.data.status,
    handoffIntentId: intent.intentId,
    ...(source.data.outputSummary ? { outputSummary: source.data.outputSummary } : {}),
    provider: adapter.provider!,
    recordedAt,
    sourceToolCallId: source.data.id,
    toolName: source.data.toolName,
  };
}
