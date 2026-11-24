import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import type { PlatformRecord } from "../records/index.ts";
import { readRecord } from "./consistent-record-read.ts";

type AgentDeployment = Extract<PlatformRecord, { readonly itemType: "agent-deployment" }>;
export type ConversationContinuationThread = Extract<
  PlatformRecord,
  { readonly itemType: "thread" }
>;

export const MAX_CONVERSATION_CONTINUATION_PREDECESSORS = 46;

export class InvalidConversationContinuityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConversationContinuityError";
  }
}

export interface ConversationContinuationScope {
  readonly agentDefinitionId: Ulid;
  readonly currentAgentDeploymentId: Ulid;
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly threadId: Ulid;
  readonly workspaceId?: Ulid;
}

export interface ConversationContinuationPredecessor {
  readonly thread: ConversationContinuationThread;
  readonly successor: ConversationContinuationThread;
  readonly throughCreatedAt: string;
}

function scopedThread(
  value: PlatformRecord | undefined,
  input: Pick<
    ConversationContinuationScope,
    "environmentId" | "organizationId" | "projectId" | "threadId" | "workspaceId"
  >,
): ConversationContinuationThread {
  if (
    value?.itemType !== "thread" ||
    value.data.id !== input.threadId ||
    value.data.environmentId !== input.environmentId ||
    value.data.organizationId !== input.organizationId ||
    value.data.projectId !== input.projectId ||
    value.data.workspaceId !== input.workspaceId
  ) {
    throw new InvalidConversationContinuityError(
      "Conversation continuity crossed its canonical thread scope.",
    );
  }
  return value;
}

function scopedDeployment(
  value: PlatformRecord | undefined,
  input: Pick<
    ConversationContinuationScope,
    "agentDefinitionId" | "environmentId" | "organizationId" | "projectId"
  > & { readonly deploymentId: Ulid },
): AgentDeployment {
  if (
    value?.itemType !== "agent-deployment" ||
    value.data.id !== input.deploymentId ||
    value.data.environmentId !== input.environmentId ||
    value.data.organizationId !== input.organizationId ||
    value.data.projectId !== input.projectId ||
    value.data.agentDefinitionId !== input.agentDefinitionId
  ) {
    throw new InvalidConversationContinuityError(
      "Conversation continuity crossed its agent definition.",
    );
  }
  return value;
}

export async function validatedConversationPredecessorLineage(
  database: DynamoDatabaseService,
  input: ConversationContinuationScope,
): Promise<readonly ConversationContinuationPredecessor[]> {
  const threadKey = (threadId: Ulid) => ({
    pk: key("ORG", input.organizationId, "THREAD", threadId),
    sk: key("THREAD", threadId),
  });
  const current = scopedThread(
    await readRecord(database, "execution", threadKey(input.threadId)),
    input,
  );
  if (current.data.agentDeploymentId !== input.currentAgentDeploymentId) {
    throw new InvalidConversationContinuityError(
      "Conversation continuity does not match the current deployment.",
    );
  }

  const predecessors: ConversationContinuationPredecessor[] = [];
  const visited = new Set<Ulid>([input.threadId]);
  let predecessorId = current.data.continuedFromThreadId;
  let throughCreatedAt = current.data.createdAt;
  let successor = current;
  while (predecessorId) {
    if (
      visited.has(predecessorId) ||
      predecessors.length >= MAX_CONVERSATION_CONTINUATION_PREDECESSORS
    ) {
      throw new InvalidConversationContinuityError(
        "Conversation continuity is cyclic or exceeds its bounded ancestry.",
      );
    }
    visited.add(predecessorId);
    const predecessor = scopedThread(
      await readRecord(database, "execution", threadKey(predecessorId)),
      { ...input, threadId: predecessorId },
    );
    const predecessorDeploymentId = predecessor.data.agentDeploymentId;
    if (predecessorDeploymentId === undefined) {
      throw new InvalidConversationContinuityError(
        "Preview and evaluation threads cannot be conversation predecessors.",
      );
    }
    scopedDeployment(
      await readRecord(database, "control", {
        pk: key("ORG", input.organizationId, "ENV", input.environmentId),
        sk: key("AGENT-DEPLOYMENT", predecessorDeploymentId),
      }),
      {
        ...input,
        deploymentId: predecessorDeploymentId,
      },
    );
    predecessors.push({ thread: predecessor, successor, throughCreatedAt });
    if (Date.parse(predecessor.data.createdAt) < Date.parse(throughCreatedAt)) {
      throughCreatedAt = predecessor.data.createdAt;
    }
    predecessorId = predecessor.data.continuedFromThreadId;
    successor = predecessor;
  }
  return predecessors;
}

export async function validatedConversationPredecessorThreads(
  database: DynamoDatabaseService,
  input: ConversationContinuationScope,
): Promise<readonly ConversationContinuationThread[]> {
  return (await validatedConversationPredecessorLineage(database, input)).map(
    ({ thread }) => thread,
  );
}
