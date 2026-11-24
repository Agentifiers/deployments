import { StreamContractError } from "./errors.ts";

export const MAX_AGENT_PLAN_TASKS = 16;
export const MAX_AGENT_PLAN_TEXT_CHARACTERS = 256;

export type AgentTaskStatus = "completed" | "failed" | "in_progress" | "pending" | "skipped";

export interface AgentTask {
  readonly details?: string;
  readonly id: string;
  readonly order: number;
  readonly status: AgentTaskStatus;
  readonly title: string;
}

export interface AgentPlanSnapshot {
  readonly revision: number;
  readonly tasks: readonly AgentTask[];
  readonly title: string;
}

export type AgentPlanUpdate =
  | { readonly eventType: "agent.plan.updated"; readonly plan: AgentPlanSnapshot }
  | {
      readonly eventType: "agent.task.updated";
      readonly plan: Pick<AgentPlanSnapshot, "revision" | "title">;
      readonly task: AgentTask;
    };

function text(field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new StreamContractError(field, `${field} is required.`);
  }
  const normalized = value.trim();
  if (Array.from(normalized).length > MAX_AGENT_PLAN_TEXT_CHARACTERS) {
    throw new StreamContractError(
      field,
      `${field} supports at most ${MAX_AGENT_PLAN_TEXT_CHARACTERS} characters.`,
    );
  }
  return normalized;
}

function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new StreamContractError("plan.revision", "Plan revisions must be positive integers.");
  }
  return Number(value);
}

function task(value: unknown): AgentTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StreamContractError("task", "Agent tasks must be objects.");
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  if (!Number.isSafeInteger(candidate.order) || Number(candidate.order) < 0) {
    throw new StreamContractError("task.order", "Task order must be a non-negative integer.");
  }
  if (
    candidate.status !== "completed" &&
    candidate.status !== "failed" &&
    candidate.status !== "in_progress" &&
    candidate.status !== "pending" &&
    candidate.status !== "skipped"
  ) {
    throw new StreamContractError("task.status", "Task status is not supported.");
  }
  return {
    ...(candidate.details === undefined
      ? {}
      : { details: text("task.details", candidate.details) }),
    id: text("task.id", candidate.id),
    order: Number(candidate.order),
    status: candidate.status,
    title: text("task.title", candidate.title),
  };
}

export function parseAgentPlanUpdate(value: unknown): AgentPlanUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StreamContractError("agentPlan", "Agent plan updates must be objects.");
  }
  const candidate = value as Readonly<Record<string, unknown>>;
  const plan = candidate.plan;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new StreamContractError("plan", "Agent plan update requires a plan object.");
  }
  const planCandidate = plan as Readonly<Record<string, unknown>>;
  const base = {
    revision: revision(planCandidate.revision),
    title: text("plan.title", planCandidate.title),
  };
  if (candidate.eventType === "agent.task.updated") {
    return { eventType: candidate.eventType, plan: base, task: task(candidate.task) };
  }
  if (candidate.eventType !== "agent.plan.updated") {
    throw new StreamContractError("eventType", "Agent plan event type is not supported.");
  }
  if (!Array.isArray(planCandidate.tasks) || planCandidate.tasks.length === 0) {
    throw new StreamContractError("plan.tasks", "Agent plans require at least one task.");
  }
  if (planCandidate.tasks.length > MAX_AGENT_PLAN_TASKS) {
    throw new StreamContractError(
      "plan.tasks",
      `Agent plans support at most ${MAX_AGENT_PLAN_TASKS} tasks.`,
    );
  }
  const tasks = planCandidate.tasks.map(task);
  if (new Set(tasks.map((item) => item.id)).size !== tasks.length) {
    throw new StreamContractError("plan.tasks", "Agent plan task IDs must be unique.");
  }
  if (new Set(tasks.map((item) => item.order)).size !== tasks.length) {
    throw new StreamContractError("plan.tasks", "Agent plan task order values must be unique.");
  }
  return { eventType: candidate.eventType, plan: { ...base, tasks } };
}
