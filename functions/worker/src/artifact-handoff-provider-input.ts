import { PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY } from "@deployments-ai/tools";
import {
  assertProviderHandoffInputTemplate,
  materializeProviderHandoffInput,
  providerHandoffInputHash,
  providerHandoffIntents,
  providerInputWithoutHandoff,
  type ProviderHandoffIntent,
} from "./artifact-handoff-runtime.ts";
import {
  accessUrl,
  loadArtifact,
  replaceArtifact,
  type RuntimeArtifactLifecycleOptions,
} from "./artifact-lifecycle-runtime-tools.ts";
import { requiredString, toolInput, ulid } from "./builtin-tool-support.ts";
import type { PrepareRuntimeProviderInput } from "./runtime-tools.ts";

export function assertArtifactHandoffMetadata(
  envelope: Readonly<Record<string, unknown>>,
  artifact: {
    readonly name: string;
    readonly storage: { readonly contentType: string; readonly fileName?: string | undefined };
  },
) {
  const contentType = requiredString(envelope, "contentType", 512);
  const fileName = requiredString(envelope, "fileName", 255);
  if (
    contentType !== artifact.storage.contentType ||
    fileName !== (artifact.storage.fileName ?? artifact.name)
  ) {
    throw new TypeError("Artifact handoff metadata does not match the canonical artifact.");
  }
}

export function assertProviderHandoffIntentNotExpired(
  intent: Pick<ProviderHandoffIntent, "expiresAt">,
  timestamp: string,
) {
  if (!intent.expiresAt || Date.parse(intent.expiresAt) <= Date.parse(timestamp)) {
    throw new TypeError("Artifact provider handoff intent has expired.");
  }
}

export function createRuntimeArtifactHandoffProviderInputPreparer(
  options: RuntimeArtifactLifecycleOptions,
): PrepareRuntimeProviderInput {
  return async (request, definition) => {
    const input = toolInput(request.input ?? {});
    const rawEnvelope = input[PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY];
    if (rawEnvelope === undefined) return { input };
    if (!rawEnvelope || typeof rawEnvelope !== "object" || Array.isArray(rawEnvelope)) {
      throw new TypeError(`${PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY} must be an object.`);
    }
    const envelope = rawEnvelope as Readonly<Record<string, unknown>>;
    const artifactId = ulid(envelope.artifactId, "_artifactHandoff.artifactId");
    const intentId = ulid(envelope.intentId, "_artifactHandoff.intentId");
    const artifact = await loadArtifact(options, request, artifactId, {
      expectedRunId: request.runId,
    });
    assertArtifactHandoffMetadata(envelope, artifact.data);
    const intents = providerHandoffIntents(artifact.data.metadata?.providerHandoffIntents);
    const intent = intents.find((candidate) => candidate.intentId === intentId);
    if (
      !intent ||
      intent.artifactId !== artifactId ||
      intent.toolName !== definition.toolName ||
      intent.toolName !== request.toolName ||
      intent.provider !== definition.provider
    ) {
      throw new TypeError("Provider write does not match an active artifact handoff intent.");
    }
    const timestamp = (options.now?.() ?? new Date()).toISOString();
    assertProviderHandoffIntentNotExpired(intent, timestamp);
    if (intent.consumedAt) {
      throw new TypeError("Artifact provider handoff intent has already been consumed.");
    }
    if (
      intent.reservedByToolCallId &&
      intent.reservedByToolCallId !== request.decision.toolCallId
    ) {
      throw new TypeError("Artifact provider handoff intent is reserved by another tool call.");
    }
    const template = providerInputWithoutHandoff(input);
    assertProviderHandoffInputTemplate(template);
    if (providerHandoffInputHash(template) !== intent.providerInputHash) {
      throw new TypeError("Provider write input does not match the artifact handoff intent.");
    }
    const access = await accessUrl(
      options,
      request,
      {
        artifactId,
        disposition: intent.disposition ?? "inline",
        expiresInSeconds: intent.accessExpiresInSeconds ?? 900,
      },
      false,
    );
    const freshIntents = providerHandoffIntents(
      access.artifact.data.metadata?.providerHandoffIntents,
    );
    const freshIntent = freshIntents.find((candidate) => candidate.intentId === intentId);
    if (!freshIntent || freshIntent.consumedAt) {
      throw new TypeError("Artifact provider handoff intent is no longer available.");
    }
    const reservationTimestamp = (options.now?.() ?? new Date()).toISOString();
    assertProviderHandoffIntentNotExpired(freshIntent, reservationTimestamp);
    if (
      freshIntent.reservedByToolCallId &&
      freshIntent.reservedByToolCallId !== request.decision.toolCallId
    ) {
      throw new TypeError("Artifact provider handoff intent is reserved by another tool call.");
    }
    const reservedIntent: ProviderHandoffIntent = {
      ...freshIntent,
      reservedAt: freshIntent.reservedAt ?? reservationTimestamp,
      reservedByToolCallId: request.decision.toolCallId,
    };
    if (!freshIntent.reservedByToolCallId) {
      await replaceArtifact(
        options,
        access.artifact,
        {
          ...access.artifact.data,
          metadata: {
            ...access.artifact.data.metadata,
            providerHandoffIntents: freshIntents.map((candidate) =>
              candidate.intentId === intentId ? reservedIntent : candidate,
            ),
          },
          updatedAt: reservationTimestamp,
          version: access.artifact.data.version + 1,
        },
        "artifact.provider-handoff.reserved",
        {
          artifactId,
          intentId,
          sourceToolCallId: request.decision.toolCallId,
        },
        request,
      );
    }
    const releaseOnRetry = async () => {
      let current;
      try {
        current = await loadArtifact(options, request, artifactId, {
          expectedRunId: request.runId,
        });
      } catch (cause) {
        if (cause instanceof TypeError) return;
        throw cause;
      }
      const currentIntents = providerHandoffIntents(current.data.metadata?.providerHandoffIntents);
      const currentIntent = currentIntents.find((candidate) => candidate.intentId === intentId);
      if (
        !currentIntent ||
        currentIntent.consumedAt ||
        currentIntent.reservedByToolCallId !== request.decision.toolCallId
      ) {
        return;
      }
      const {
        reservedAt: _reservedAt,
        reservedByToolCallId: _reservedByToolCallId,
        ...releasedIntent
      } = currentIntent;
      const releasedAt = (options.now?.() ?? new Date()).toISOString();
      await replaceArtifact(
        options,
        current,
        {
          ...current.data,
          metadata: {
            ...current.data.metadata,
            providerHandoffIntents: currentIntents.map((candidate) =>
              candidate.intentId === intentId ? releasedIntent : candidate,
            ),
          },
          updatedAt: releasedAt,
          version: current.data.version + 1,
        },
        "artifact.provider-handoff.released",
        {
          artifactId,
          intentId,
          sourceToolCallId: request.decision.toolCallId,
        },
        request,
      );
    };
    return {
      input: {
        ...materializeProviderHandoffInput(template, {
          contentType: access.artifact.data.storage.contentType,
          fileName: access.artifact.data.storage.fileName ?? access.artifact.data.name,
          url: access.url,
        }),
        [PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY]: envelope,
      },
      persistCanonicalHandoffResponse: true,
      releaseOnRetry,
    };
  };
}
