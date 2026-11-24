import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  key,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
  workerPersistence,
} from "@deployments-ai/db";
import { PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY } from "@deployments-ai/tools";
import { RuntimeToolPreparationRetryableError } from "@deployments-ai/agent-runtime";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";
export { replaceArtifact } from "./artifact-lifecycle-mutation.ts";
import { replaceArtifact } from "./artifact-lifecycle-mutation.ts";
export { publicArtifact } from "./artifact-access-results.ts";
import {
  preparedArtifactAccessResult,
  publicArtifact,
  transientArtifactAccess,
} from "./artifact-access-results.ts";
import {
  jsonToolResult,
  logicallyExpired,
  optionalInteger,
  optionalString,
  requiredString,
  toolInput,
  ulid,
} from "./builtin-tool-support.ts";
import {
  assertProviderHandoffInputTemplate,
  assertProviderWriteTarget,
  assertSourceMatchesHandoffIntent,
  appendProviderHandoffIntent,
  canonicalProviderHandoff,
  providerHandoffInputHash,
  providerHandoffIntents,
  type ProviderHandoffIntent,
  type ProviderHandoffSourceToolCall,
} from "./artifact-handoff-runtime.ts";
import { sourceRunArtifactPage, sourceRunArtifacts } from "./artifact-source-run.ts";
import { artifactBucketAllowed } from "./artifact-buckets.ts";

type Artifact = Extract<PlatformRecord, { readonly itemType: "artifact" }>;
const MAX_HANDOFF_INTENT_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const MAX_HANDOFF_PROVIDER_INPUT_BYTES = 64 * 1024;

export interface RuntimeArtifactLifecycleOptions {
  readonly artifactBucket: string;
  readonly legacyArtifactBuckets?: readonly string[];
  readonly artifactS3: Pick<S3Client, "send">;
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<Ulid>;
  readonly now?: () => Date;
  readonly signAccessUrl?: typeof getSignedUrl;
}

function now(options: RuntimeArtifactLifecycleOptions) {
  return options.now?.() ?? new Date();
}

export async function loadArtifact(
  options: RuntimeArtifactLifecycleOptions,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  artifactId: Ulid,
  access: { readonly expectedRunId: Ulid; readonly mutation?: boolean },
) {
  let value: PlatformRecord | undefined;
  try {
    value = await workerPersistence.read(
      options.database,
      "execution",
      {
        pk: key("ORG", request.organizationId, "ENV", request.environmentId),
        sk: key("ARTIFACT", artifactId),
      },
      true,
    );
  } catch (cause) {
    throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
  }
  if (
    value?.itemType !== "artifact" ||
    value.data.projectId !== request.projectId ||
    value.data.environmentId !== request.environmentId ||
    value.data.runId !== access.expectedRunId ||
    logicallyExpired(value.data.retentionExpiresAt, now(options).getTime())
  ) {
    throw new TypeError("Artifact was not found in the current run scope.");
  }
  const currentRun = value.data.runId === request.runId;
  const currentAgent = value.data.agentDeploymentId === request.agentDeploymentId;
  const readable = value.data.visibility !== "private" || currentRun;
  if (!readable || (access.mutation === true && !currentRun && !currentAgent)) {
    throw new TypeError("Artifact was not found in the current run scope.");
  }
  return value;
}

export function sharedArtifactVisibility(visibility: Artifact["data"]["visibility"]) {
  return visibility === "private" ? ("organization" as const) : visibility;
}

function accessSeconds(
  input: Readonly<Record<string, unknown>>,
  artifact: Artifact,
  accessTime: Date,
) {
  const requested =
    optionalInteger(input, "expiresInSeconds", { maximum: 3_600, minimum: 60 }) ?? 900;
  if (!artifact.data.retentionExpiresAt) return requested;
  const remaining = Math.floor(
    (Date.parse(artifact.data.retentionExpiresAt) - accessTime.getTime()) / 1_000,
  );
  if (!Number.isSafeInteger(remaining) || remaining < 1) {
    throw new TypeError("Artifact retention has expired.");
  }
  return Math.min(requested, remaining);
}

function dispositionFileName(artifact: Artifact) {
  return Array.from(artifact.data.storage.fileName ?? artifact.data.name)
    .map((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f || '"\\/'.includes(character)
        ? "-"
        : character;
    })
    .join("")
    .slice(0, 255);
}

function artifactAccessWindow(
  options: RuntimeArtifactLifecycleOptions,
  input: Readonly<Record<string, unknown>>,
  artifact: Artifact,
) {
  if (artifact.data.status !== "available" || !artifact.data.storage.versionId) {
    throw new TypeError("Artifact is not available or version pinned.");
  }
  if (
    !artifactBucketAllowed(
      artifact.data.storage.bucket,
      options.artifactBucket,
      options.legacyArtifactBuckets,
    )
  ) {
    throw new TypeError("Artifact storage is outside the configured runtime bucket.");
  }
  const at = now(options);
  const expiresIn = accessSeconds(input, artifact, at);
  return {
    at,
    expiresAt: new Date(at.getTime() + expiresIn * 1_000).toISOString(),
    expiresIn,
  };
}

async function signedArtifactUrl(
  options: RuntimeArtifactLifecycleOptions,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  input: Readonly<Record<string, unknown>>,
  artifact: Artifact,
  window: ReturnType<typeof artifactAccessWindow>,
) {
  try {
    return await (options.signAccessUrl ?? getSignedUrl)(
      options.artifactS3 as S3Client,
      new GetObjectCommand({
        Bucket: artifact.data.storage.bucket,
        Key: artifact.data.storage.key,
        ResponseContentDisposition: `${input.disposition === "attachment" ? "attachment" : "inline"}; filename="${dispositionFileName(artifact)}"`,
        VersionId: artifact.data.storage.versionId,
      }),
      { expiresIn: window.expiresIn, signingDate: window.at },
    );
  } catch (cause) {
    throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
  }
}

export async function accessUrl(
  options: RuntimeArtifactLifecycleOptions,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  input: Readonly<Record<string, unknown>>,
  share: boolean,
) {
  const sourceRunId = input.sourceRunId ? ulid(input.sourceRunId, "sourceRunId") : request.runId;
  const artifact = await loadArtifact(options, request, ulid(input.artifactId, "artifactId"), {
    expectedRunId: sourceRunId,
    mutation: share,
  });
  const window = artifactAccessWindow(options, input, artifact);
  const url = await signedArtifactUrl(options, request, input, artifact, window);
  const latestExpiration =
    artifact.data.accessUrlExpiresAt &&
    Date.parse(artifact.data.accessUrlExpiresAt) > Date.parse(window.expiresAt)
      ? artifact.data.accessUrlExpiresAt
      : window.expiresAt;
  if (!share && latestExpiration === artifact.data.accessUrlExpiresAt) {
    return { artifact, expiresAt: window.expiresAt, url };
  }
  const next = await replaceArtifact(
    options,
    artifact,
    {
      ...artifact.data,
      accessUrlExpiresAt: latestExpiration,
      visibility: share
        ? sharedArtifactVisibility(artifact.data.visibility)
        : artifact.data.visibility,
      updatedAt: window.at.toISOString(),
      version: artifact.data.version + 1,
    },
    share ? "artifact.shared" : "artifact.access-granted",
    {
      artifactId: artifact.data.id,
      expiresAt: window.expiresAt,
      ...(artifact.data.runId ? { runId: artifact.data.runId } : {}),
    },
    request,
  );
  return { artifact: next, expiresAt: window.expiresAt, url };
}

export async function loadSourceToolCall(
  options: RuntimeArtifactLifecycleOptions,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  toolCallId: Ulid,
  intent: ProviderHandoffIntent,
): Promise<ProviderHandoffSourceToolCall> {
  const completed = request.completedToolCalls?.find((call) => call.toolCallId === toolCallId);
  if (completed) {
    return {
      data: {
        createdAt: intent.reservedAt ?? intent.createdAt,
        externalOperationId: completed.externalOperationId,
        id: completed.toolCallId,
        input: completed.input,
        outputSummary: completed.outputSummary,
        status: "succeeded",
        toolName: completed.toolName,
      },
    };
  }
  let value: PlatformRecord | undefined;
  try {
    value = await workerPersistence.read(
      options.database,
      "execution",
      {
        pk: key("ORG", request.organizationId, "RUN", request.runId),
        sk: key("TOOL-CALL", toolCallId),
      },
      true,
    );
  } catch (cause) {
    throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
  }
  if (
    value?.itemType !== "tool-call" ||
    value.data.id !== toolCallId ||
    value.data.organizationId !== request.organizationId ||
    value.data.projectId !== request.projectId ||
    value.data.environmentId !== request.environmentId ||
    value.data.runId !== request.runId
  ) {
    throw new TypeError("Source tool call was not found in the current run scope.");
  }
  return value;
}

export function providerInput(input: Readonly<Record<string, unknown>>) {
  const value = input.providerInput;
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("providerInput must be an object.");
  }
  const providerInput = value as Readonly<Record<string, unknown>>;
  if (
    new TextEncoder().encode(JSON.stringify(providerInput)).byteLength >
    MAX_HANDOFF_PROVIDER_INPUT_BYTES
  ) {
    throw new TypeError(
      `providerInput must not exceed ${MAX_HANDOFF_PROVIDER_INPUT_BYTES} encoded bytes.`,
    );
  }
  return providerInput;
}

export function createRuntimeArtifactLifecycleBuiltinExecutors(
  options: RuntimeArtifactLifecycleOptions,
): Readonly<Record<string, ExecuteRuntimeBuiltinTool>> {
  const share = Object.assign(
    async (request: Parameters<ExecuteRuntimeBuiltinTool>[0]) => {
      const result = await accessUrl(options, request, toolInput(request.input ?? {}), true);
      return preparedArtifactAccessResult(result.artifact, result.expiresAt, result.url, "share");
    },
    {
      refreshReplay: async (
        request: Parameters<ExecuteRuntimeBuiltinTool>[0],
        _definition: Parameters<NonNullable<ExecuteRuntimeBuiltinTool["refreshReplay"]>>[1],
        persistedResult: Parameters<NonNullable<ExecuteRuntimeBuiltinTool["refreshReplay"]>>[2],
      ) => {
        const input = toolInput(request.input ?? {});
        const sourceRunId = input.sourceRunId
          ? ulid(input.sourceRunId, "sourceRunId")
          : request.runId;
        const artifact = await loadArtifact(
          options,
          request,
          ulid(input.artifactId, "artifactId"),
          { expectedRunId: sourceRunId, mutation: true },
        );
        if (artifact.data.visibility === "private") {
          throw new TypeError("Artifact share has not reached its durable terminal state.");
        }
        const window = artifactAccessWindow(options, input, artifact);
        const url = await signedArtifactUrl(options, request, input, artifact, window);
        if (
          !artifact.data.accessUrlExpiresAt ||
          Date.parse(artifact.data.accessUrlExpiresAt) < Date.parse(window.expiresAt)
        ) {
          await replaceArtifact(
            options,
            artifact,
            {
              ...artifact.data,
              accessUrlExpiresAt: window.expiresAt,
              updatedAt: window.at.toISOString(),
              version: artifact.data.version + 1,
            },
            "artifact.accessed",
            {
              artifactId: artifact.data.id,
              expiresAt: window.expiresAt,
              ...(artifact.data.runId ? { runId: artifact.data.runId } : {}),
            },
            request,
          );
        }
        return {
          ...persistedResult,
          transientArtifacts: [transientArtifactAccess(artifact, window.expiresAt, url, "share")],
        };
      },
    },
  ) satisfies ExecuteRuntimeBuiltinTool;
  return {
    "artifact.inspect": async (request) => {
      const result = await accessUrl(options, request, toolInput(request.input ?? {}), false);
      return preparedArtifactAccessResult(result.artifact, result.expiresAt, result.url, "inspect");
    },
    "artifact.share": share,
    "artifact.source_run": (request) => sourceRunArtifacts(options, request),
    "artifact.archive": async (request) => {
      const input = toolInput(request.input ?? {});
      const sourceRunId = input.sourceRunId
        ? ulid(input.sourceRunId, "sourceRunId")
        : request.runId;
      const artifact = await loadArtifact(options, request, ulid(input.artifactId, "artifactId"), {
        expectedRunId: sourceRunId,
        mutation: true,
      });
      if (artifact.data.status === "deleted")
        return jsonToolResult({
          fileName: `artifact-${artifact.data.id}.json`,
          label: "Archived artifact",
          summary: `Artifact ${artifact.data.name} was already archived.`,
          value: publicArtifact(artifact, false),
        });
      const timestamp = now(options).toISOString();
      const next = await replaceArtifact(
        options,
        artifact,
        {
          ...artifact.data,
          status: "deleted",
          updatedAt: timestamp,
          version: artifact.data.version + 1,
        },
        "artifact.archived",
        {
          artifactId: artifact.data.id,
          ...(artifact.data.runId ? { runId: artifact.data.runId } : {}),
        },
        request,
      );
      return jsonToolResult({
        fileName: `artifact-${next.data.id}.json`,
        label: "Archived artifact",
        summary: `Archived artifact ${next.data.name}.`,
        value: publicArtifact(next, false),
      });
    },
    "artifact.provider_handoffs.list": async (request) => {
      const input = toolInput(request.input ?? {});
      const page = await sourceRunArtifactPage(options, request, {
        ...input,
        sourceRunId: request.runId,
      });
      const records = page.artifacts.filter((artifact) => artifact.status === "available");
      return jsonToolResult({
        fileName: "provider-handoff-artifacts.json",
        label: "Provider handoff artifacts",
        summary: `Found ${records.length} artifact(s) ready for provider handoff${page.nextCursor ? "; more are available" : ""}.`,
        value: { artifacts: records, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) },
      });
    },
    "artifact.provider_handoffs.prepare": async (request) => {
      const result = await accessUrl(options, request, toolInput(request.input ?? {}), false);
      if (result.artifact.data.runId !== request.runId)
        throw new TypeError("Only current-run artifacts may be handed off.");
      return preparedArtifactAccessResult(
        result.artifact,
        result.expiresAt,
        result.url,
        "provider-handoff",
      );
    },
    "artifact.provider_handoffs.plan_write": async (request) => {
      const input = toolInput(request.input ?? {});
      const provider = requiredString(input, "provider", 128);
      const targetToolName = requiredString(input, "toolName", 256);
      assertProviderWriteTarget(provider, targetToolName);
      const requestedTargetInput = providerInput(input);
      if (PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY in requestedTargetInput) {
        throw new TypeError(`${PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY} is reserved.`);
      }
      assertProviderHandoffInputTemplate(requestedTargetInput);
      const artifact = await loadArtifact(options, request, ulid(input.artifactId, "artifactId"), {
        expectedRunId: request.runId,
      });
      if (artifact.data.runId !== request.runId)
        throw new TypeError("Only current-run artifacts may be handed off.");
      artifactAccessWindow(options, input, artifact);
      const artifactStatus = optionalString(input, "artifactStatus", 32);
      const timestamp = now(options).toISOString();
      const intentExpiresAt = new Date(
        Math.min(
          Date.parse(timestamp) + MAX_HANDOFF_INTENT_LIFETIME_MS,
          artifact.data.retentionExpiresAt
            ? Date.parse(artifact.data.retentionExpiresAt)
            : Number.POSITIVE_INFINITY,
        ),
      ).toISOString();
      const intent: ProviderHandoffIntent = {
        accessExpiresInSeconds:
          optionalInteger(input, "expiresInSeconds", { maximum: 3_600, minimum: 60 }) ?? 900,
        artifactId: artifact.data.id,
        createdAt: timestamp,
        disposition: input.disposition === "attachment" ? "attachment" : "inline",
        expiresAt: intentExpiresAt,
        intentId: request.decision.toolCallId,
        provider,
        providerInputHash: providerHandoffInputHash(requestedTargetInput),
        toolName: targetToolName,
      };
      const priorIntents = providerHandoffIntents(artifact.data.metadata?.providerHandoffIntents);
      const planned = await replaceArtifact(
        options,
        artifact,
        {
          ...artifact.data,
          metadata: {
            ...artifact.data.metadata,
            providerHandoffIntents: appendProviderHandoffIntent(priorIntents, intent, timestamp),
          },
          updatedAt: intent.createdAt,
          version: artifact.data.version + 1,
        },
        "artifact.provider-handoff.planned",
        {
          artifactId: intent.artifactId,
          intentId: intent.intentId,
          provider: intent.provider,
          toolName: intent.toolName,
        },
        request,
      );
      return jsonToolResult({
        fileName: `artifact-${planned.data.id}-write-plan.json`,
        label: "Provider write plan",
        summary: `Planned provider handoff for ${planned.data.name}.`,
        value: {
          artifactId: planned.data.id,
          artifactStatus,
          provider,
          toolName: targetToolName,
          input: {
            ...requestedTargetInput,
            [PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY]: {
              artifactId: planned.data.id,
              contentType: planned.data.storage.contentType,
              fileName: planned.data.storage.fileName ?? planned.data.name,
              intentId: intent.intentId,
            },
          },
        },
      });
    },
    "artifact.provider_handoffs.record_result": async (request) => {
      const input = toolInput(request.input ?? {});
      const artifact = await loadArtifact(options, request, ulid(input.artifactId, "artifactId"), {
        expectedRunId: request.runId,
        mutation: true,
      });
      if (artifact.data.runId !== request.runId)
        throw new TypeError("Only current-run artifacts may be handed off.");
      const provider = requiredString(input, "provider", 128);
      const targetToolName = requiredString(input, "toolName", 256);
      const handoffIntentId = ulid(input.handoffIntentId, "handoffIntentId");
      const sourceToolCallId = ulid(input.sourceToolCallId, "sourceToolCallId");
      const timestamp = now(options).toISOString();
      const intents = providerHandoffIntents(artifact.data.metadata?.providerHandoffIntents);
      const intent = intents.find((candidate) => candidate.intentId === handoffIntentId);
      if (!intent || intent.artifactId !== artifact.data.id) {
        throw new TypeError("Artifact provider handoff intent was not found.");
      }
      if (intent.provider !== provider || intent.toolName !== targetToolName) {
        throw new TypeError(
          "Artifact provider handoff intent does not match the requested target.",
        );
      }
      const sourceToolCall = await loadSourceToolCall(options, request, sourceToolCallId, intent);
      const handoff = canonicalProviderHandoff(sourceToolCall, intent, timestamp);
      assertSourceMatchesHandoffIntent(sourceToolCall, intent);
      const prior = artifact.data.metadata?.providerHandoffs;
      const history = Array.isArray(prior) ? prior.slice(-19) : [];
      if (intent.consumedAt) {
        if (intent.sourceToolCallId !== sourceToolCallId) {
          throw new TypeError("Artifact provider handoff intent has already been consumed.");
        }
        const replay = history.find(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            entry.handoffIntentId === intent.intentId &&
            entry.sourceToolCallId === sourceToolCallId,
        );
        if (!replay) throw new TypeError("Artifact provider handoff history is inconsistent.");
        return jsonToolResult({
          fileName: `artifact-${artifact.data.id}-handoff-result.json`,
          label: "Provider handoff result",
          summary: `Recorded ${intent.provider} handoff result for ${artifact.data.name}.`,
          value: { artifact: publicArtifact(artifact, false), handoff: replay },
        });
      }
      const consumedIntent: ProviderHandoffIntent = {
        ...intent,
        consumedAt: timestamp,
        sourceToolCallId,
      };
      const next = await replaceArtifact(
        options,
        artifact,
        {
          ...artifact.data,
          metadata: {
            ...artifact.data.metadata,
            providerHandoffIntents: intents
              .map((candidate) =>
                candidate.intentId === intent.intentId ? consumedIntent : candidate,
              )
              .slice(-20),
            providerHandoffs: [...history, handoff],
          },
          updatedAt: timestamp,
          version: artifact.data.version + 1,
        },
        "artifact.provider-handoff.recorded",
        {
          artifactId: artifact.data.id,
          provider: handoff.provider,
          sourceToolCallId: handoff.sourceToolCallId,
          toolName: handoff.toolName,
        },
        request,
      );
      return jsonToolResult({
        fileName: `artifact-${next.data.id}-handoff-result.json`,
        label: "Provider handoff result",
        summary: `Recorded ${handoff.provider} handoff result for ${next.data.name}.`,
        value: { artifact: publicArtifact(next, false), handoff },
      });
    },
  };
}
