import type { RuntimeSandboxPolicy } from "@deployments-ai/agent-runtime";
import type { ObservabilitySourceContext, SandboxExecutionTargetKind } from "@deployments-ai/db";
import type { ManagedSandbox } from "@deployments-ai/sandbox-hosts";

export const THREAD_SANDBOX_WORKSPACE_ROOT = "/workspace";

export interface ThreadSandboxScope {
  readonly environmentId: string;
  /** Deployment id for customer runs; execution binding id for preview/evaluation runs. */
  readonly executionTargetId: string;
  readonly executionTargetKind: SandboxExecutionTargetKind;
  readonly organizationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly workspaceId?: string;
}

export interface ThreadSandboxAcquireInput extends ThreadSandboxScope {
  /** Trace context of the acquiring run; stamped on a lease this acquisition allocates. */
  readonly observability: ObservabilitySourceContext;
  readonly policy: RuntimeSandboxPolicy;
  readonly signal?: AbortSignal;
}

export interface ThreadSandboxReleaseOptions {
  /** Epoch milliseconds by which archiving and upload must finish; the sandbox is kept otherwise. */
  readonly deadline?: number;
  /** Release only a sandbox that the scope's run leased, never one a later run took over. */
  readonly onlyIfLeasedByRun?: boolean;
}

/**
 * Owns the thread-persistent sandbox for one (thread, execution target) pair.
 *
 * A run allocates at most one MicroVM, initialized from the latest durable
 * `/workspace` snapshot. `release` has the sandbox archive `/workspace` and upload
 * it to private object storage, then destroys the MicroVM; it runs at every run
 * exit while the worker still owns the thread execution lease, except a checkpoint, after which
 * the same run resumes on the same MicroVM so open windows and processes survive.
 */
export interface ThreadSandboxWorkspace {
  /** Returns a ready sandbox whose `/workspace` holds the thread's latest files. */
  readonly acquire: (input: ThreadSandboxAcquireInput) => Promise<ManagedSandbox>;
  /** Snapshots and destroys the thread's sandbox. Never throws; failures are recorded and logged. */
  readonly release: (
    scope: ThreadSandboxScope,
    options?: ThreadSandboxReleaseOptions,
  ) => Promise<void>;
}
