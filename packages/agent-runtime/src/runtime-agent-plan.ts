import type { AgentRunInput, AgentRuntimeDependencies } from "./types.ts";
import { executionContext, iso, now } from "./runtime-core.ts";
import { MAX_AGENT_PLAN_TEXT_CHARACTERS, type AgentPlanUpdate } from "@deployments-ai/streaming";

function boundedPlanText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty.`);
  return Array.from(normalized).slice(0, MAX_AGENT_PLAN_TEXT_CHARACTERS).join("");
}

function initialTasks(input: AgentRunInput) {
  const tasks: Array<{
    readonly id: string;
    readonly status: "pending";
    readonly title: string;
  }> = [];
  if ((input.memoryMode ?? "off") !== "off" || (input.brainRetrievalMode ?? "off") !== "off") {
    tasks.push({ id: "gather-context", status: "pending", title: "Gather context" });
  }
  if (
    (input.toolRequests?.length ?? 0) > 0 ||
    (input.modelToolNames?.length ?? 0) > 0 ||
    (input.modelContinuation?.toolRequests.length ?? 0) > 0
  ) {
    tasks.push({ id: "use-tools", status: "pending", title: "Use tools as needed" });
  }
  if ((input.sandboxCommands?.length ?? 0) > 0) {
    tasks.push({ id: "run-sandbox", status: "pending", title: "Run sandbox work" });
  }
  tasks.push({ id: "produce-response", status: "pending", title: "Produce the response" });
  return tasks.map((task, order) => ({ ...task, order }));
}

export class RuntimeAgentPlanTracker {
  readonly #dependencies: AgentRuntimeDependencies;
  readonly #input: AgentRunInput;
  #revision = 0;
  #snapshotPublished = false;
  readonly #tasks: Array<{
    details?: string;
    id: string;
    order: number;
    status: "completed" | "failed" | "in_progress" | "pending" | "skipped";
    title: string;
  }>;
  readonly #title: string;

  constructor(input: AgentRunInput, dependencies: AgentRuntimeDependencies) {
    this.#input = input;
    this.#dependencies = dependencies;
    this.#tasks = initialTasks(input);
    this.#title = "Complete the request";
  }

  hasTask(id: string): boolean {
    return this.#tasks.some((task) => task.id === id);
  }

  async start(): Promise<void> {
    this.#revision = 1;
    this.#snapshotPublished = await this.#publish({
      eventType: "agent.plan.updated",
      plan: {
        revision: this.#revision,
        tasks: this.#tasks.map((task) => ({ ...task })),
        title: this.#title,
      },
    });
  }

  async updateTask(
    id: string,
    status: "completed" | "failed" | "in_progress" | "pending" | "skipped",
    details?: string,
  ): Promise<void> {
    const index = this.#tasks.findIndex((task) => task.id === id);
    if (index < 0) throw new Error(`Agent plan task ${id} is not defined.`);
    const previous = this.#tasks[index]!;
    const normalizedDetails = details ? boundedPlanText(details, "Agent task details") : undefined;
    if (previous.status === status && previous.details === normalizedDetails) return;
    const { details: _previousDetails, ...taskWithoutDetails } = previous;
    const task = {
      ...taskWithoutDetails,
      ...(normalizedDetails ? { details: normalizedDetails } : {}),
      status,
    };
    this.#tasks[index] = task;
    this.#revision += 1;
    if (!this.#snapshotPublished) {
      this.#snapshotPublished = await this.#publish({
        eventType: "agent.plan.updated",
        plan: {
          revision: this.#revision,
          tasks: this.#tasks.map((candidate) => ({ ...candidate })),
          title: this.#title,
        },
      });
    } else {
      this.#snapshotPublished = await this.#publish({
        eventType: "agent.task.updated",
        plan: { revision: this.#revision, title: this.#title },
        task: { ...task },
      });
    }
  }

  async skipPending(): Promise<void> {
    for (const task of this.#tasks) {
      if (task.status === "pending") await this.updateTask(task.id, "skipped");
    }
  }

  async perform<Result>(
    id: string,
    operation: () => Promise<Result>,
    outcome: (result: Result) => {
      readonly details?: string;
      readonly status: "completed" | "in_progress";
    } = () => ({ status: "completed" }),
  ): Promise<Result> {
    await this.updateTask(id, "in_progress");
    const result = await operation();
    const next = outcome(result);
    await this.updateTask(id, next.status, next.details);
    return result;
  }

  async failActive(details: string): Promise<void> {
    for (const active of this.#tasks.filter((task) => task.status === "in_progress")) {
      await this.updateTask(active.id, "failed", details);
    }
  }

  async failActiveAndSkipPending(details: string): Promise<void> {
    await this.failActive(details);
    await this.skipPending();
  }

  async #publish(update: AgentPlanUpdate): Promise<boolean> {
    if (!this.#dependencies.publishAgentPlan) return false;
    try {
      await this.#dependencies.publishAgentPlan({
        ...executionContext(this.#input),
        ...update,
        occurredAt: iso(now(this.#dependencies)),
        runAttempt: this.#input.runAttempt,
        runExecutionVersion: this.#input.runExecutionVersion,
      });
      return true;
    } catch {
      // Canonical plan publication is auxiliary and must not discard completed agent work.
      return false;
    }
  }
}

export function runtimeToolPlanOutcome(result: {
  readonly status: "completed" | "waiting-for-approval" | "waiting-for-tool";
}) {
  if (result.status === "completed") return { status: "completed" as const };
  return {
    details:
      result.status === "waiting-for-approval"
        ? "Waiting for approval"
        : "Waiting for tool completion",
    status: "in_progress" as const,
  };
}
