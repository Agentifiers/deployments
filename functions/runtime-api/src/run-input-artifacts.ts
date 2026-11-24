import {
  artifactOwnerOf,
  loadRunInputArtifacts,
  RunInputArtifactError,
  sameArtifactOwner,
  type PlatformRecord,
} from "@deployments-ai/db";
import { conversationCodeStatus } from "./conversation-error-status.ts";
import { runInitiatingCaller } from "./runtime-principal.ts";
import {
  RuntimeApiError,
  requireScope,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

export async function authorizeRunInputArtifacts(
  dependencies: RuntimeApiDependencies,
  principal: RuntimeApiPrincipal,
  run: Extract<PlatformRecord, { readonly itemType: "run" }>,
): Promise<void> {
  if (!run.data.inputArtifacts) return;
  requireScope(principal, "artifacts:read");
  const owner = artifactOwnerOf(run.data.initiatingCaller);
  if (!sameArtifactOwner(owner, artifactOwnerOf(runInitiatingCaller(principal)))) {
    throw new RuntimeApiError(
      404,
      "input_artifact_unavailable",
      "Private run input artifacts are unavailable to this caller.",
    );
  }
  try {
    await loadRunInputArtifacts(dependencies.database, {
      ...principal.scope,
      threadId: run.data.threadId,
      artifactIds: run.data.inputArtifacts,
      owner,
      now: dependencies.now?.() ?? new Date(),
    });
  } catch (cause) {
    if (cause instanceof RunInputArtifactError) {
      throw new RuntimeApiError(conversationCodeStatus(cause.code), cause.code, cause.message);
    }
    throw cause;
  }
}
