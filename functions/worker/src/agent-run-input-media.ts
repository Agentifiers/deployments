import type {
  RuntimeAttachmentIndexEntry,
  RuntimeConversationMessage,
  RuntimeInputMedia,
  RuntimeInputOmission,
} from "@deployments-ai/agent-runtime";
import {
  artifactOwnerOf,
  inputMediaPolicyOf,
  listReadableAttachments,
  loadRunInputArtifacts,
  RunInputArtifactError,
  type AdmittedRunInputArtifact,
  type ArtifactOwner,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import { imageInputModelChain, type ImageInputSupport } from "@deployments-ai/model-gateway";
import { AgentRunWorkerRecordError } from "./records.ts";
import type { RunRecordValue } from "./types.ts";

export interface RunInputMediaAdmission {
  readonly inputMedia?: RuntimeInputMedia;
  readonly inputOmissions: readonly RuntimeInputOmission[];
  readonly modelFallbackIds: readonly string[];
  readonly readableDocuments: boolean;
}

interface ImageAdmission {
  readonly kept: readonly AdmittedRunInputArtifact[];
  readonly inputOmissions: readonly RuntimeInputOmission[];
  readonly modelFallbackIds: readonly string[];
}

function admitImages(
  files: readonly AdmittedRunInputArtifact[],
  owner: ArtifactOwner,
  chain: { readonly modelFallbackIds: readonly string[]; readonly modelId: string },
  imageInput: ReadonlyMap<string, ImageInputSupport>,
): ImageAdmission {
  if (!files.some(({ file }) => file.kind === "image")) {
    return { inputOmissions: [], kept: files, modelFallbackIds: chain.modelFallbackIds };
  }
  const admitted = imageInputModelChain(chain, imageInput);
  switch (admitted.kind) {
    case "accepted":
      return { inputOmissions: [], kept: files, modelFallbackIds: admitted.modelFallbackIds };
    case "primary-unaccepted": {
      if (inputMediaPolicyOf(owner) === "offer") {
        return {
          inputOmissions: files.flatMap(({ file, record }) =>
            file.kind === "image" ? [{ name: record.data.name, reason: "images_unsupported" }] : [],
          ),
          kept: files.filter(({ file }) => file.kind !== "image"),
          modelFallbackIds: chain.modelFallbackIds,
        };
      }
      const code = `model_image_input_${admitted.support}`;
      throw new AgentRunWorkerRecordError(
        code,
        `Pinned model ${chain.modelId} cannot read this run's image input (${code}).`,
      );
    }
    default: {
      const unhandled: never = admitted;
      throw new Error(`Unhandled image input chain ${JSON.stringify(unhandled)}`);
    }
  }
}

export async function admitRunInputMedia(
  database: DynamoDatabaseService,
  run: RunRecordValue,
  chain: { readonly modelFallbackIds: readonly string[]; readonly modelId: string },
  imageInput: ReadonlyMap<string, ImageInputSupport>,
  now: Date,
): Promise<RunInputMediaAdmission> {
  if (!run.data.inputArtifacts) {
    return {
      inputOmissions: [],
      modelFallbackIds: chain.modelFallbackIds,
      readableDocuments: false,
    };
  }
  const owner = artifactOwnerOf(run.data.initiatingCaller);
  const files = await loadRunInputArtifacts(database, {
    artifactIds: run.data.inputArtifacts,
    environmentId: run.data.environmentId,
    now,
    organizationId: run.data.organizationId,
    owner,
    projectId: run.data.projectId,
    threadId: run.data.threadId,
  }).catch((cause: unknown) => {
    if (cause instanceof RunInputArtifactError)
      throw new AgentRunWorkerRecordError(cause.code, cause.message);
    throw cause;
  });
  const { inputOmissions, kept, modelFallbackIds } = admitImages(files, owner, chain, imageInput);
  return {
    ...(kept.length > 0
      ? {
          inputMedia: {
            artifactIds: kept.map(({ record }) => record.data.id),
            owner,
            promptMessageId: run.data.userMessageId,
          },
        }
      : {}),
    inputOmissions,
    modelFallbackIds,
    readableDocuments: kept.some(({ file }) => file.kind === "document"),
  };
}

export async function earlierAttachmentIndex(
  database: DynamoDatabaseService,
  run: RunRecordValue,
  recentMessages: readonly RuntimeConversationMessage[],
  now: Date,
): Promise<readonly RuntimeAttachmentIndexEntry[]> {
  const caller = run.data.initiatingCaller;
  if (!caller) return [];
  const seen = new Set<string>(run.data.inputArtifacts);
  const candidates: { readonly artifactId: string; readonly turnsAgo: number }[] = [];
  let turnsAgo = 0;
  for (const message of recentMessages.toReversed()) {
    if (message.role !== "user") continue;
    turnsAgo += 1;
    for (const artifactId of message.inputArtifacts ?? []) {
      if (seen.has(artifactId)) continue;
      seen.add(artifactId);
      candidates.push({ artifactId, turnsAgo });
    }
  }
  const listed = await listReadableAttachments(database, {
    candidates,
    environmentId: run.data.environmentId,
    now,
    organizationId: run.data.organizationId,
    owner: artifactOwnerOf(caller),
    projectId: run.data.projectId,
    threadId: run.data.threadId,
  });
  return listed.map(({ candidate, file, record }) => ({
    artifactId: record.data.id,
    name: record.data.name,
    summary: file.summary,
    textBytes: file.text.byteSize,
    turnsAgo: candidate.turnsAgo,
  }));
}
