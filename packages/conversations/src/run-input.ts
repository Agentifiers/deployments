import {
  AgentInputArtifacts,
  AgentResponseFormat,
  inputFileProblemCode,
  type AgentManifestV1,
  type InputFileOmissionReason,
} from "@deployments-ai/agent-manifest";
import {
  artifactOwnerOf,
  evaluateRunInputArtifacts,
  inputMediaPolicyOf,
  loadModelImageInputSupport,
  loadRunInputArtifacts,
  MAX_LISTED_INPUT_OMISSIONS,
  partitionByAggregateLimit,
  RunInputArtifactError,
  type ArtifactOwner,
  type DynamoDatabaseService,
  type InputFileOmission,
  type RunInputArtifact,
  type RunInputArtifactScope,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  ConversationError,
  type ConversationMessage,
  type SubmitConversationTurnInput,
} from "./submission.ts";

export type InputMediaOmissionReason =
  | RunInputArtifactError["code"]
  | "aggregate_limit"
  | "ingress_attachments_disabled"
  | "model_image_input_unknown"
  | "model_image_input_unsupported";

export interface InputMediaOmission {
  readonly artifactId: string;
  readonly reason: InputMediaOmissionReason;
}

type TurnInputOmissions = Pick<
  ConversationMessage["data"],
  "inputOmissions" | "unlistedInputOmissions"
>;

export interface AdmittedInputMedia {
  readonly attached?: readonly Ulid[];
  readonly omissions: TurnInputOmissions;
  readonly omitted: readonly InputMediaOmission[];
}

type InputMediaScope = RunInputArtifactScope & {
  readonly artifactIds: readonly string[];
  readonly now: Date;
};

const MAX_OMITTED_NAME_CHARACTERS = 200;

function turnInputOmissions(told: readonly InputFileOmission[]): TurnInputOmissions {
  const listed = told.slice(0, MAX_LISTED_INPUT_OMISSIONS).map(({ name, reason }) => ({
    name: Array.from(name).slice(0, MAX_OMITTED_NAME_CHARACTERS).join(""),
    reason,
  }));
  return {
    ...(listed.length > 0 ? { inputOmissions: listed } : {}),
    ...(told.length > listed.length ? { unlistedInputOmissions: told.length - listed.length } : {}),
  };
}

export function validateSubmittedRunInput(input: SubmitConversationTurnInput): void {
  try {
    if (input.responseFormat !== undefined)
      Schema.decodeUnknownSync(AgentResponseFormat)(input.responseFormat);
    if (input.inputArtifacts !== undefined)
      Schema.decodeUnknownSync(AgentInputArtifacts)(input.inputArtifacts);
  } catch (cause) {
    throw new ConversationError(
      "invalid_run_input",
      "Response format or input artifacts are invalid.",
      { cause },
    );
  }
}

function submittedMediaOwner(input: SubmitConversationTurnInput): ArtifactOwner {
  const caller = input.initiatingCaller;
  const { actor } = input;
  switch (caller?.type) {
    case "principal":
      if (actor.type === "principal" && actor.id === caller.principalId)
        return artifactOwnerOf(caller);
      break;
    case "service-account":
      if (actor.type === "service-account" && actor.id === caller.serviceAccountId)
        return artifactOwnerOf(caller);
      break;
    case "ingress":
      if (actor.type === "system") return artifactOwnerOf(caller);
      break;
    case undefined:
      break;
    default: {
      const unhandled: never = caller;
      throw new Error(`Unhandled run initiating caller ${JSON.stringify(unhandled)}`);
    }
  }
  throw new ConversationError(
    "invalid_input_artifacts",
    "Input artifacts must be submitted by the caller that owns them.",
  );
}

async function requireInputMedia(
  database: DynamoDatabaseService,
  scope: InputMediaScope,
  manifest: AgentManifestV1,
): Promise<readonly Ulid[]> {
  const admitted = await loadRunInputArtifacts(database, scope).catch((cause: unknown) => {
    if (cause instanceof RunInputArtifactError)
      throw new ConversationError(cause.code, cause.message);
    throw cause;
  });
  const ids = admitted.map(({ record }) => record.data.id);
  if (!admitted.some(({ file }) => file.kind === "image")) return ids;
  const modelId = manifest.spec.model.id;
  const support = await loadModelImageInputSupport(database, modelId);
  if (support === "supported") return ids;
  throw new ConversationError(
    `model_image_input_${support}`,
    support === "unsupported"
      ? `The release's model ${modelId} cannot read image input.`
      : `The release's model ${modelId} has no known image input support.`,
  );
}

async function offerInputMedia(
  database: DynamoDatabaseService,
  scope: InputMediaScope,
  manifest: AgentManifestV1,
  skipped: readonly InputFileOmission[],
): Promise<AdmittedInputMedia> {
  const omissions = new Map<
    string,
    { readonly reason: InputMediaOmissionReason; readonly told?: InputFileOmission }
  >();
  const omitSilently = (artifactId: string, reason: InputMediaOmissionReason) =>
    omissions.set(artifactId, { reason });
  const omitAndTell = (
    record: RunInputArtifact,
    reason: InputMediaOmissionReason,
    toldReason: InputFileOmissionReason,
  ) =>
    omissions.set(record.data.id, {
      reason,
      told: { name: record.data.name, reason: toldReason },
    });
  const verdicts =
    scope.artifactIds.length > 0 ? await evaluateRunInputArtifacts(database, scope) : [];
  const attachmentsEnabled = manifest.spec.runtime?.ingressAttachments === "attach";
  for (const verdict of verdicts) {
    if (verdict.kind === "rejected") {
      omitSilently(
        verdict.artifactId,
        attachmentsEnabled ? verdict.reason : "ingress_attachments_disabled",
      );
    } else if (!attachmentsEnabled) {
      omitAndTell(verdict.record, "ingress_attachments_disabled", "attachments_disabled");
    } else if (verdict.kind === "unusable") {
      omitAndTell(verdict.record, inputFileProblemCode(verdict.reason), verdict.reason);
    }
  }
  const { kept, overflow } = partitionByAggregateLimit(
    verdicts.flatMap((verdict) =>
      verdict.kind === "available" && attachmentsEnabled ? [verdict] : [],
    ),
  );
  for (const { record } of overflow) {
    omitAndTell(record, "aggregate_limit", "over_turn_cap");
  }
  const images = kept.filter(({ file }) => file.kind === "image");
  if (images.length > 0) {
    const support = await loadModelImageInputSupport(database, manifest.spec.model.id);
    if (support !== "supported") {
      for (const { record } of images) {
        omitAndTell(record, `model_image_input_${support}`, "images_unsupported");
      }
    }
  }
  const attached = kept.flatMap(({ record }) =>
    omissions.has(record.data.id) ? [] : [record.data.id],
  );
  const omitted = scope.artifactIds.flatMap((artifactId) => {
    const omission = omissions.get(artifactId);
    return omission ? [{ artifactId, ...omission }] : [];
  });
  return {
    ...(attached.length > 0 ? { attached } : {}),
    omissions: turnInputOmissions([
      ...omitted.flatMap(({ told }) => (told ? [told] : [])),
      ...skipped.map(({ name, reason }) => ({
        name,
        reason: attachmentsEnabled ? reason : "attachments_disabled",
      })),
    ]),
    omitted: omitted.map(({ artifactId, reason }) => ({ artifactId, reason })),
  };
}

export async function admitSubmittedInputMedia(
  database: DynamoDatabaseService,
  input: SubmitConversationTurnInput,
  manifest: AgentManifestV1,
  now: Date,
): Promise<AdmittedInputMedia> {
  if (input.inputArtifacts === undefined && input.skippedInputFiles === undefined) {
    return { omissions: {}, omitted: [] };
  }
  const owner = submittedMediaOwner(input);
  const policy = inputMediaPolicyOf(owner);
  if (!input.threadId) {
    throw new ConversationError("invalid_input_artifacts", "Input artifacts require a thread ID.");
  }
  const scope = {
    ...input,
    artifactIds: input.inputArtifacts ?? [],
    now,
    owner,
    threadId: input.threadId,
  };
  switch (policy) {
    case "require":
      if (input.skippedInputFiles !== undefined) {
        throw new ConversationError(
          "invalid_input_artifacts",
          "Only provider ingress reports skipped input files.",
        );
      }
      return {
        attached: await requireInputMedia(database, scope, manifest),
        omissions: {},
        omitted: [],
      };
    case "offer":
      return offerInputMedia(database, scope, manifest, input.skippedInputFiles ?? []);
    default: {
      const unhandled: never = policy;
      throw new Error(`Unhandled submitted media policy ${JSON.stringify(unhandled)}`);
    }
  }
}
