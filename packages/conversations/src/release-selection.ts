import type { Ulid } from "@deployments-ai/db";
import { createHash } from "node:crypto";
import type { AgentDeployment, AgentRelease, ConversationThread } from "./submission.ts";

export type AgentReleaseSelection = "candidate" | "primary";

export interface AgentReleaseSelectionInput {
  readonly deployment: AgentDeployment;
  /** A caller-pinned release; it must still be one of the deployment's selectable releases. */
  readonly requestedAgentReleaseId?: Ulid | undefined;
  /** Ignore the thread's sticky release and select again from the current deployment state. */
  readonly rebaseRelease?: boolean | undefined;
  readonly thread?: ConversationThread | undefined;
  readonly threadId: Ulid;
}

export interface AgentReleaseSelectionResult {
  readonly agentReleaseId: Ulid;
  readonly releaseSelection: AgentReleaseSelection;
  /** Thread fields to persist so later turns on the thread keep the same release. */
  readonly threadPin: { readonly pinnedAgentReleaseId?: Ulid };
}

/**
 * Deterministic canary bucket in [0, 100) for one thread of one deployment. The version prefix
 * keeps assignments stable across releases of this code; changing it reshuffles every thread.
 */
export function canaryBucket(deploymentId: string, threadId: string) {
  const digest = createHash("sha256").update(`canary-v1|${deploymentId}|${threadId}`).digest();
  return digest.readUInt32BE(0) % 100;
}

/**
 * Chooses the release for a new run. Threads are sticky: once a thread has run during a canary
 * it keeps its release until the release stops being selectable or the caller rebases.
 */
export function selectAgentRelease(
  input: AgentReleaseSelectionInput,
): AgentReleaseSelectionResult | undefined {
  const primary = input.deployment.data.agentReleaseId;
  const candidate = input.deployment.data.candidateAgentReleaseId;
  const weight = input.deployment.data.candidateWeight ?? 0;
  const pinned = input.thread?.data.pinnedAgentReleaseId;
  const selectable = (releaseId: Ulid | undefined): releaseId is Ulid =>
    releaseId !== undefined && (releaseId === primary || releaseId === candidate);

  let agentReleaseId: Ulid;
  if (input.requestedAgentReleaseId !== undefined) {
    if (!selectable(input.requestedAgentReleaseId)) return undefined;
    agentReleaseId = input.requestedAgentReleaseId;
  } else if (!input.rebaseRelease && selectable(pinned)) {
    agentReleaseId = pinned;
  } else if (candidate && canaryBucket(input.deployment.data.id, input.threadId) < weight) {
    agentReleaseId = candidate;
  } else {
    agentReleaseId = primary;
  }
  return {
    agentReleaseId,
    releaseSelection: agentReleaseId === candidate ? "candidate" : "primary",
    threadPin:
      candidate !== undefined || pinned !== undefined
        ? { pinnedAgentReleaseId: agentReleaseId }
        : {},
  };
}

export async function ingressAttachmentsEnabled(
  deployment: AgentDeployment,
  loadRelease: (releaseId: Ulid) => Promise<AgentRelease | undefined>,
): Promise<boolean> {
  const { agentReleaseId, candidateAgentReleaseId } = deployment.data;
  const releases = await Promise.all(
    (candidateAgentReleaseId === undefined
      ? [agentReleaseId]
      : [agentReleaseId, candidateAgentReleaseId]
    ).map(loadRelease),
  );
  return releases.some(
    (release) =>
      release?.data.status === "active" &&
      release.data.manifest.spec.runtime?.ingressAttachments === "attach",
  );
}
