import { RuntimeHostShutdownError } from "@deployments-ai/agent-runtime";
import type { AgentRunHostDrain } from "./types.ts";

/**
 * Drain lifecycle of the long-lived worker host. After `start` the host stops receiving, runs
 * checkpoint at their next safe boundary, and at the deadline `signal` aborts the remainder with
 * a `RuntimeHostShutdownError` so they are requeued instead of canceled.
 */
export interface WorkerDrain extends AgentRunHostDrain {
  /** Clears the pending deadline timer once the host has finished draining. */
  readonly dispose: () => void;
  /** Starts draining; later calls keep the first deadline. */
  readonly start: () => void;
  /** Resolves when draining starts. */
  readonly started: Promise<void>;
}

export interface WorkerDrainOptions {
  readonly now?: () => number;
  /** Schedules the deadline abort; returns its cancel function. Test seam for a fake clock. */
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
  readonly timeoutMs: number;
}

export function createWorkerDrain(options: WorkerDrainOptions): WorkerDrain {
  const now = options.now ?? Date.now;
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    });
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  let deadline: number | undefined;
  let cancelDeadline: (() => void) | undefined;
  return {
    deadline: () => deadline,
    dispose: () => cancelDeadline?.(),
    signal: controller.signal,
    start: () => {
      if (deadline !== undefined) return;
      deadline = now() + options.timeoutMs;
      started.resolve();
      cancelDeadline = schedule(
        () => controller.abort(new RuntimeHostShutdownError()),
        options.timeoutMs,
      );
    },
    started: started.promise,
  };
}
