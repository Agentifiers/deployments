import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionConditionCheck } from "../client-types.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import { ConversationCheckpointRecord } from "../records/conversations.ts";
import { transactWithSemanticEvents } from "../semantic-event-storage.ts";
import type { Ulid } from "../ids.ts";

type AgentDeployment = Extract<PlatformRecord, { readonly itemType: "agent-deployment" }>;
type ConversationCheckpoint = Extract<
  PlatformRecord,
  { readonly itemType: "conversation-checkpoint" }
>;
type SemanticEvent = Extract<PlatformRecord, { readonly itemType: "semantic-event" }>;
type Thread = Extract<PlatformRecord, { readonly itemType: "thread" }>;
type Workspace = Extract<PlatformRecord, { readonly itemType: "workspace" }>;

export function continuationCheckpointRecord(
  source: ConversationCheckpoint,
  target: {
    readonly agentDeploymentId: Ulid;
    readonly createdAt: string;
    readonly id: Ulid;
    readonly threadId: Ulid;
  },
): ConversationCheckpoint {
  return Schema.decodeUnknownSync(ConversationCheckpointRecord)(
    withCanonicalRecordKeys({
      data: {
        agentDeploymentId: target.agentDeploymentId,
        contentHash: source.data.contentHash,
        continuedFromCheckpointId: source.data.id,
        continuedFromThreadId: source.data.threadId,
        continuedFromThroughSequence: source.data.throughSequence,
        createdAt: target.createdAt,
        environmentId: source.data.environmentId,
        ...(source.data.fromMessageCreatedAt
          ? { fromMessageCreatedAt: source.data.fromMessageCreatedAt }
          : {}),
        fromSequence: 0,
        id: target.id,
        organizationId: source.data.organizationId,
        projectId: source.data.projectId,
        runId: source.data.runId,
        sourceMessageCount: source.data.sourceMessageCount,
        summary: source.data.summary,
        threadId: target.threadId,
        ...(source.data.throughMessageCreatedAt
          ? { throughMessageCreatedAt: source.data.throughMessageCreatedAt }
          : {}),
        throughSequence: 0,
      },
      itemType: "conversation-checkpoint" as const,
    }),
  );
}

function recordIdentityCondition(
  record: PlatformRecord,
  extra: Omit<TransactionConditionCheck, "key" | "kind" | "table">,
): TransactionConditionCheck {
  return {
    ...extra,
    key: { pk: record.pk, sk: record.sk },
    kind: "condition-check",
    table:
      record.itemType === "agent-deployment" || record.itemType === "workspace"
        ? "control"
        : "execution",
  };
}

export function makeConversationThreadContinuityPersistence(database: DynamoDatabaseService) {
  return {
    async createSuccessor(input: {
      readonly checkpoint?: ConversationCheckpoint;
      readonly event: SemanticEvent;
      readonly predecessorCheckpoint?: ConversationCheckpoint;
      readonly predecessorDeployment: AgentDeployment;
      readonly predecessorThread: Thread;
      readonly targetDeployment: AgentDeployment;
      readonly thread: Thread;
      readonly workspace?: Workspace;
    }): Promise<void> {
      const targetDeploymentCondition = recordIdentityCondition(input.targetDeployment, {
        conditionExpression:
          "#itemType = :itemType AND #data.#version = :version AND #data.#currentState = :ready AND #data.#desiredState = :running",
        expressionAttributeNames: {
          "#currentState": "currentState",
          "#data": "data",
          "#desiredState": "desiredState",
          "#itemType": "itemType",
          "#version": "version",
        },
        expressionAttributeValues: {
          ":itemType": "agent-deployment",
          ":ready": "ready",
          ":running": "running",
          ":version": input.targetDeployment.data.version,
        },
      });
      const predecessorDeploymentCondition = recordIdentityCondition(input.predecessorDeployment, {
        conditionExpression:
          "#itemType = :itemType AND #data.#agentDefinitionId = :agentDefinitionId AND #data.#version = :version",
        expressionAttributeNames: {
          "#agentDefinitionId": "agentDefinitionId",
          "#data": "data",
          "#itemType": "itemType",
          "#version": "version",
        },
        expressionAttributeValues: {
          ":agentDefinitionId": input.predecessorDeployment.data.agentDefinitionId,
          ":itemType": "agent-deployment",
          ":version": input.predecessorDeployment.data.version,
        },
      });
      const predecessorThreadCondition = recordIdentityCondition(input.predecessorThread, {
        conditionExpression:
          "#itemType = :itemType AND #data.#agentDeploymentId = :agentDeploymentId AND #data.#version = :version",
        expressionAttributeNames: {
          "#agentDeploymentId": "agentDeploymentId",
          "#data": "data",
          "#itemType": "itemType",
          "#version": "version",
        },
        expressionAttributeValues: {
          ":agentDeploymentId": input.predecessorThread.data.agentDeploymentId,
          ":itemType": "thread",
          ":version": input.predecessorThread.data.version,
        },
      });
      const predecessorCheckpointCondition = input.predecessorCheckpoint
        ? recordIdentityCondition(input.predecessorCheckpoint, {
            conditionExpression:
              "#itemType = :itemType AND #data.#contentHash = :contentHash AND #data.#throughSequence = :throughSequence",
            expressionAttributeNames: {
              "#contentHash": "contentHash",
              "#data": "data",
              "#itemType": "itemType",
              "#throughSequence": "throughSequence",
            },
            expressionAttributeValues: {
              ":contentHash": input.predecessorCheckpoint.data.contentHash,
              ":itemType": "conversation-checkpoint",
              ":throughSequence": input.predecessorCheckpoint.data.throughSequence,
            },
          })
        : undefined;
      const workspaceCondition = input.workspace
        ? recordIdentityCondition(input.workspace, {
            conditionExpression:
              "#itemType = :itemType AND #data.#version = :version AND #data.#status = :active",
            expressionAttributeNames: {
              "#data": "data",
              "#itemType": "itemType",
              "#status": "status",
              "#version": "version",
            },
            expressionAttributeValues: {
              ":active": "active",
              ":itemType": "workspace",
              ":version": input.workspace.data.version,
            },
          })
        : undefined;

      await transactWithSemanticEvents(
        database,
        [
          { kind: "put", record: input.thread },
          ...(input.checkpoint ? [{ kind: "put" as const, record: input.checkpoint }] : []),
          targetDeploymentCondition,
          predecessorDeploymentCondition,
          predecessorThreadCondition,
          ...(predecessorCheckpointCondition ? [predecessorCheckpointCondition] : []),
          ...(workspaceCondition ? [workspaceCondition] : []),
        ],
        [input.event],
      );
    },

    async saveCheckpointAtThreadVersions(input: {
      readonly checkpoint: ConversationCheckpoint;
      readonly sourceCheckpoints: readonly ConversationCheckpoint[];
      readonly threads: readonly Thread[];
    }): Promise<void> {
      const threadConditions = input.threads.map((thread) =>
        recordIdentityCondition(thread, {
          conditionExpression:
            "#itemType = :itemType AND #data.#agentDeploymentId = :agentDeploymentId AND #data.#version = :version",
          expressionAttributeNames: {
            "#agentDeploymentId": "agentDeploymentId",
            "#data": "data",
            "#itemType": "itemType",
            "#version": "version",
          },
          expressionAttributeValues: {
            ":agentDeploymentId": thread.data.agentDeploymentId,
            ":itemType": "thread",
            ":version": thread.data.version,
          },
        }),
      );
      const sourceConditions = input.sourceCheckpoints.map((checkpoint) =>
        recordIdentityCondition(checkpoint, {
          conditionExpression:
            "#itemType = :itemType AND #data.#contentHash = :contentHash AND #data.#throughSequence = :throughSequence",
          expressionAttributeNames: {
            "#contentHash": "contentHash",
            "#data": "data",
            "#itemType": "itemType",
            "#throughSequence": "throughSequence",
          },
          expressionAttributeValues: {
            ":contentHash": checkpoint.data.contentHash,
            ":itemType": "conversation-checkpoint",
            ":throughSequence": checkpoint.data.throughSequence,
          },
        }),
      );
      await database.transactWrite([
        { kind: "put", record: input.checkpoint },
        ...threadConditions,
        ...sourceConditions,
      ]);
    },
  };
}
