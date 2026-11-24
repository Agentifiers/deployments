import { Schema } from "effect";
import { createHash } from "node:crypto";
import type { DynamoDatabaseService } from "../client-types.ts";
import { AgentRunPlanRecord } from "../records/runtime-work.ts";
import { key } from "../keys.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";
import {
  internalSemanticEventPayload,
  makeSemanticEventRecord,
  transactWithSemanticEvents,
} from "../semantic-event-storage.ts";
import type { Ulid } from "../ids.ts";
import type { AgentPlanUpdate } from "@deployments-ai/streaming";

type AgentRunPlan = Extract<PlatformRecord, { readonly itemType: "agent-run-plan" }>;
type Run = Extract<PlatformRecord, { readonly itemType: "run" }>;
type RuntimeLease = Extract<PlatformRecord, { readonly itemType: "runtime-lease" }>;

export interface PersistAgentRunPlanInput {
  readonly environmentId: Ulid;
  readonly eventId: Ulid;
  readonly expectedLease: RuntimeLease;
  readonly expectedRun: Run;
  readonly occurredAt: string;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly runAttempt: number;
  readonly runClaimedAt: string;
  readonly runExecutionVersion: number;
  readonly runId: Ulid;
  readonly threadId: Ulid;
  readonly traceId: string;
  readonly update: AgentPlanUpdate;
  readonly workspaceId?: Ulid;
}

export interface PersistAgentRunPlanResult {
  readonly record: AgentRunPlan;
  readonly shouldPublish: boolean;
}

function recordKey(input: Pick<PersistAgentRunPlanInput, "organizationId" | "runId">) {
  return {
    pk: key("ORG", input.organizationId, "RUN", input.runId),
    sk: key("AGENT-RUN-PLAN", input.runId),
  };
}

function applyUpdate(
  previous: AgentRunPlan | undefined,
  input: PersistAgentRunPlanInput,
): AgentRunPlan {
  if (previous && input.runExecutionVersion < previous.data.runExecutionVersion) return previous;
  const newGeneration = !previous || input.runExecutionVersion > previous.data.runExecutionVersion;
  if (!newGeneration && input.update.plan.revision <= previous.data.planRevision) return previous!;
  let tasks;
  if (input.update.eventType === "agent.plan.updated") {
    tasks = input.update.plan.tasks;
  } else {
    const taskUpdate = input.update;
    if (!previous || newGeneration) {
      throw new Error("Agent task updates require a plan snapshot for the run generation.");
    }
    if (taskUpdate.plan.title !== previous.data.title) {
      throw new Error("Agent task updates cannot change the plan title.");
    }
    const index = previous.data.tasks.findIndex((task) => task.id === taskUpdate.task.id);
    if (index < 0) throw new Error(`Agent plan task ${taskUpdate.task.id} is not defined.`);
    tasks = previous.data.tasks.map((task, taskIndex) =>
      taskIndex === index ? taskUpdate.task : task,
    );
  }
  const timestamp = input.occurredAt;
  return Schema.decodeUnknownSync(AgentRunPlanRecord)(
    withCanonicalRecordKeys({
      data: {
        ...(input.expectedRun.data.executionBindingId === undefined
          ? { agentDeploymentId: input.expectedRun.data.agentDeploymentId }
          : {
              executionBindingId: input.expectedRun.data.executionBindingId,
              executionPurpose: input.expectedRun.data.executionPurpose,
            }),
        createdAt: previous?.data.createdAt ?? timestamp,
        environmentId: input.environmentId,
        id: input.runId,
        organizationId: input.organizationId,
        planRevision: input.update.plan.revision,
        projectId: input.projectId,
        runAttempt: input.runAttempt,
        runClaimedAt: input.runClaimedAt,
        runExecutionVersion: input.runExecutionVersion,
        runId: input.runId,
        tasks,
        threadId: input.threadId,
        title: input.update.plan.title,
        traceId: input.traceId,
        updatedAt: timestamp,
        version: previous ? previous.data.version + 1 : 0,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      },
      itemType: "agent-run-plan" as const,
    }),
  );
}

function sameTask(
  left: AgentRunPlan["data"]["tasks"][number],
  right: AgentRunPlan["data"]["tasks"][number],
) {
  return (
    left.id === right.id &&
    left.order === right.order &&
    left.status === right.status &&
    left.title === right.title &&
    left.details === right.details
  );
}

function updateMatches(record: AgentRunPlan, input: PersistAgentRunPlanInput) {
  if (
    record.data.runExecutionVersion !== input.runExecutionVersion ||
    record.data.planRevision !== input.update.plan.revision ||
    record.data.title !== input.update.plan.title
  ) {
    return false;
  }
  const update = input.update;
  if (update.eventType === "agent.task.updated") {
    const task = record.data.tasks.find((candidate) => candidate.id === update.task.id);
    return task ? sameTask(task, update.task) : false;
  }
  return (
    record.data.tasks.length === update.plan.tasks.length &&
    record.data.tasks.every((task, index) => sameTask(task, update.plan.tasks[index]!))
  );
}

export function makeAgentRunPlanPersistence(database: DynamoDatabaseService) {
  async function load(input: Pick<PersistAgentRunPlanInput, "organizationId" | "runId">) {
    const value = await database.getRecord("execution", recordKey(input), true);
    if (!value) return undefined;
    if (value.itemType !== "agent-run-plan") {
      throw new Error("Agent run plan key contains an unexpected record.");
    }
    return value;
  }

  return {
    load,
    async persist(input: PersistAgentRunPlanInput): Promise<PersistAgentRunPlanResult> {
      if (
        input.expectedRun.data.id !== input.runId ||
        input.expectedRun.data.status !== "running" ||
        !input.expectedRun.data.claimedBy ||
        input.expectedRun.data.organizationId !== input.organizationId ||
        input.expectedRun.data.projectId !== input.projectId ||
        input.expectedRun.data.environmentId !== input.environmentId ||
        input.expectedRun.data.workspaceId !== input.workspaceId ||
        input.expectedRun.data.threadId !== input.threadId ||
        input.expectedRun.data.traceId !== input.traceId ||
        input.expectedRun.data.attempt !== input.runAttempt ||
        input.runExecutionVersion > input.expectedRun.data.version ||
        input.expectedLease.data.runId !== input.runId ||
        input.expectedLease.data.owner !== input.expectedRun.data.claimedBy ||
        input.expectedLease.data.id !== input.threadId ||
        (input.expectedLease.data.organizationId !== undefined &&
          input.expectedLease.data.organizationId !== input.organizationId) ||
        (input.expectedLease.data.projectId !== undefined &&
          input.expectedLease.data.projectId !== input.projectId) ||
        (input.expectedLease.data.environmentId !== undefined &&
          input.expectedLease.data.environmentId !== input.environmentId)
      ) {
        throw new Error("Agent plan persistence requires the active run execution lease.");
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const previous = await load(input);
        const record = applyUpdate(previous, input);
        if (record === previous) {
          return { record, shouldPublish: updateMatches(record, input) };
        }
        const payload = {
          planRevision: record.data.planRevision,
          runExecutionVersion: record.data.runExecutionVersion,
          runId: record.data.runId,
          ...(input.update.eventType === "agent.task.updated"
            ? {
                task: {
                  id: input.update.task.id,
                  order: input.update.task.order,
                  status: input.update.task.status,
                  title: input.update.task.title,
                  ...(input.update.task.details ? { details: input.update.task.details } : {}),
                },
              }
            : {
                plan: {
                  revision: input.update.plan.revision,
                  tasks: input.update.plan.tasks.map((task) => ({
                    id: task.id,
                    order: task.order,
                    status: task.status,
                    title: task.title,
                    ...(task.details ? { details: task.details } : {}),
                  })),
                  title: input.update.plan.title,
                },
              }),
        };
        const event = makeSemanticEventRecord({
          aggregateId: input.runId,
          aggregateType: "agent-run-plan",
          aggregateVersion: record.data.version + 1,
          environmentId: input.environmentId,
          eventId: input.eventId,
          eventType: input.update.eventType,
          occurredAt: input.occurredAt,
          organizationId: input.organizationId,
          payload:
            input.expectedRun.data.executionBindingId === undefined
              ? payload
              : internalSemanticEventPayload(payload),
          projectId: input.projectId,
          traceId: input.traceId,
        });
        const operation = previous
          ? { kind: "put" as const, previousRecord: previous, record }
          : {
              conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              kind: "put" as const,
              record,
            };
        const token = createHash("sha256")
          .update(
            `${input.runId}:${input.runExecutionVersion}:${input.update.plan.revision}:${record.data.version}`,
          )
          .digest("hex")
          .slice(0, 36);
        const runCondition = {
          conditionExpression:
            "#data.#status = :running AND #data.#claimedBy = :claimedBy AND #data.#version = :runVersion",
          expressionAttributeNames: {
            "#claimedBy": "claimedBy",
            "#data": "data",
            "#status": "status",
            "#version": "version",
          },
          expressionAttributeValues: {
            ":claimedBy": input.expectedRun.data.claimedBy,
            ":running": "running",
            ":runVersion": input.expectedRun.data.version,
          },
          key: { pk: input.expectedRun.pk, sk: input.expectedRun.sk },
          kind: "condition-check" as const,
          table: "execution" as const,
        };
        const leaseCondition = {
          conditionExpression:
            "#data.#owner = :owner AND #data.#runId = :runId AND #data.#version = :leaseVersion",
          expressionAttributeNames: {
            "#data": "data",
            "#owner": "owner",
            "#runId": "runId",
            "#version": "version",
          },
          expressionAttributeValues: {
            ":leaseVersion": input.expectedLease.data.version,
            ":owner": input.expectedLease.data.owner,
            ":runId": input.runId,
          },
          key: { pk: input.expectedLease.pk, sk: input.expectedLease.sk },
          kind: "condition-check" as const,
          table: "execution" as const,
        };
        try {
          await transactWithSemanticEvents(
            database,
            [operation, runCondition, leaseCondition],
            [event],
            token,
          );
          return { record, shouldPublish: true };
        } catch (cause) {
          const current = await load(input);
          if (
            current &&
            current.data.runExecutionVersion === input.runExecutionVersion &&
            current.data.planRevision >= input.update.plan.revision
          ) {
            return { record: current, shouldPublish: updateMatches(current, input) };
          }
          if (attempt === 2) throw cause;
        }
      }
      throw new Error("Agent run plan persistence retry limit was exhausted.");
    },
  };
}
