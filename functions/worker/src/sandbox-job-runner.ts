import type { ManagedSandbox, SandboxManagerService } from "@deployments-ai/sandbox-hosts";
import { Effect } from "effect";
import { setTimeout as delay } from "node:timers/promises";

const CONTROL_COMMAND_TIMEOUT_MS = 30_000;
const FIRST_POLL_DELAY_MS = 500;
const MAX_POLL_DELAY_MS = 5_000;

export interface SandboxJobContext {
  /** Epoch milliseconds after which a still-running job is reported as `timeout`. */
  readonly deadline: number;
  readonly manager: Pick<SandboxManagerService, "exec" | "upload">;
  readonly now: () => number;
  readonly sandbox: ManagedSandbox;
  readonly signal: AbortSignal | undefined;
}

type SandboxJobPendingState = "missing" | "running" | "started";

/**
 * One detached job inside a sandbox. The control program is run as
 * `[...control, "start", startArgument]`, which must print `{"state":"started"}` after spawning a
 * detached worker, and `[...control, "status", statusArgument]`, which prints one JSON status line:
 * `running` while the worker lives, `missing` when no job exists, or a terminal state.
 */
export interface SandboxJob<Status extends { readonly state: string }> {
  readonly control: readonly string[];
  /** Decodes one parsed status line; throws on anything outside the job's protocol. */
  readonly decodeStatus: (value: unknown) => Status;
  /** Prefix for runner errors, e.g. `Workspace transfer`. */
  readonly label: string;
  readonly startArgument: string;
  readonly statusArgument: string;
  /** Files written in order before `start`; secrets belong here, never on a command line. */
  readonly uploads: readonly { readonly content: string; readonly path: string }[];
}

export type SandboxJobOutcome<Status extends { readonly state: string }> =
  | Exclude<Status, { readonly state: SandboxJobPendingState }>
  | { readonly state: "timeout" };

async function control<Status extends { readonly state: string }>(
  context: SandboxJobContext,
  job: SandboxJob<Status>,
  args: readonly string[],
): Promise<Status> {
  const executed = await Effect.runPromise(
    context.manager.exec({
      command: [...job.control, ...args],
      sandbox: context.sandbox,
      timeoutMs: CONTROL_COMMAND_TIMEOUT_MS,
      ...(context.signal ? { signal: context.signal } : {}),
    }),
  );
  if ("operationId" in executed) {
    throw new Error(`${job.label} control returned an asynchronous handle.`);
  }
  if (executed.exitCode !== 0) {
    throw new Error(`${job.label} control exited with status ${executed.exitCode}.`);
  }
  return job.decodeStatus(JSON.parse(executed.stdout));
}

/**
 * Uploads the job files, starts the detached job, and polls it with exponential backoff until it
 * settles or the deadline passes.
 */
export async function runSandboxJob<Status extends { readonly state: string }>(
  context: SandboxJobContext,
  job: SandboxJob<Status>,
): Promise<SandboxJobOutcome<Status>> {
  const encoder = new TextEncoder();
  for (const upload of job.uploads) {
    // eslint-disable-next-line no-await-in-loop -- Uploads land in the declared order.
    await Effect.runPromise(
      context.manager.upload({
        content: encoder.encode(upload.content),
        path: upload.path,
        sandbox: context.sandbox,
        ...(context.signal ? { signal: context.signal } : {}),
      }),
    );
  }
  const started = await control(context, job, ["start", job.startArgument]);
  if (started.state !== "started") {
    throw new Error(`${job.label} job did not start.`);
  }
  let pause = FIRST_POLL_DELAY_MS;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- Polling is inherently sequential.
    const status = await control(context, job, ["status", job.statusArgument]);
    if (status.state === "missing" || status.state === "started") {
      throw new Error(`${job.label} job status is unavailable.`);
    }
    if (status.state !== "running") return status as SandboxJobOutcome<Status>;
    const remaining = context.deadline - context.now();
    if (remaining <= 0) return { state: "timeout" };
    // eslint-disable-next-line no-await-in-loop -- Polling is inherently sequential.
    await delay(
      Math.min(pause, remaining),
      undefined,
      context.signal ? { signal: context.signal } : {},
    );
    pause = Math.min(MAX_POLL_DELAY_MS, pause * 2);
  }
}
