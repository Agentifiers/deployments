import { describe, expect, test } from "bun:test";
import type { AgentRunExecutionPins, RuntimeSandboxPolicy } from "@deployments-ai/agent-runtime";
import type { Ulid } from "@deployments-ai/db";
import type { ThreadSandboxScope, ThreadSandboxWorkspace } from "./contracts.ts";
import type { RunRecordValue } from "../types.ts";
import { executeWithThreadSandboxRelease, releaseThreadSandboxKeptByRun } from "./run-exit.ts";

const runScope = {
  environmentId: "env",
  organizationId: "org",
  projectId: "proj",
  runId: "run",
  threadId: "thr",
};
const deploymentPins: AgentRunExecutionPins = {
  agentDefinitionId: "def" as Ulid,
  agentDeploymentId: "dep" as Ulid,
  agentReleaseId: "release" as Ulid,
};
const scope: ThreadSandboxScope = {
  ...runScope,
  executionTargetId: "dep",
  executionTargetKind: "agent-deployment",
};

function recorder() {
  const events: string[] = [];
  const released: ThreadSandboxScope[] = [];
  const deadlines: (number | undefined)[] = [];
  const threadSandbox: ThreadSandboxWorkspace = {
    acquire: async () => {
      throw new Error("unused");
    },
    release: async (releasedScope, options) => {
      events.push("release");
      released.push(releasedScope);
      deadlines.push(options?.deadline);
    },
  };
  return { deadlines, events, released, threadSandbox };
}

const input = (
  mode: RuntimeSandboxPolicy["mode"],
  pins: AgentRunExecutionPins = deploymentPins,
) => ({
  ...runScope,
  ...pins,
  sandboxPolicy: { mode, provider: "aws_lambda_microvm" as const },
});
const clock = { now: () => 1_000_000 };
const done = { completionStatus: "completed" as const };

describe("thread sandbox run exit", () => {
  test("releases the thread sandbox after the run returns", async () => {
    const { events, released, threadSandbox } = recorder();

    const result = await executeWithThreadSandboxRelease(
      threadSandbox,
      input("thread-persistent"),
      clock,
      async () => {
        events.push("execute");
        return done;
      },
    );

    expect(result).toBe(done);
    expect(events).toEqual(["execute", "release"]);
    expect(released).toEqual([scope]);
  });

  test("releases a preview run's sandbox under its execution binding", async () => {
    const { released, threadSandbox } = recorder();

    await executeWithThreadSandboxRelease(
      threadSandbox,
      input("thread-persistent", {
        executionBindingId: "dep" as Ulid,
        executionPurpose: "preview",
      }),
      clock,
      async () => done,
    );

    expect(released).toEqual([
      { ...runScope, executionTargetId: "dep", executionTargetKind: "execution-binding" },
    ]);
  });

  test("releases the thread sandbox before the run failure propagates", async () => {
    const { events, threadSandbox } = recorder();
    const failure = new Error("runtime failed");

    expect(
      executeWithThreadSandboxRelease(
        threadSandbox,
        input("thread-persistent"),
        clock,
        async () => {
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(events).toEqual(["release"]);
  });

  test("gives release 150 s from the run exit, capped by a host drain deadline", async () => {
    const { deadlines, threadSandbox } = recorder();
    let now = 1_000_000;
    const drainDeadline: { value?: number } = {};
    const releaseClock = { drainDeadline: () => drainDeadline.value, now: () => now };

    await executeWithThreadSandboxRelease(
      threadSandbox,
      input("thread-persistent"),
      releaseClock,
      async () => {
        now = 1_400_000;
        return done;
      },
    );
    drainDeadline.value = 1_460_000;
    await executeWithThreadSandboxRelease(
      threadSandbox,
      input("thread-persistent"),
      releaseClock,
      async () => done,
    );
    drainDeadline.value = 2_000_000;
    await executeWithThreadSandboxRelease(
      threadSandbox,
      input("thread-persistent"),
      releaseClock,
      async () => done,
    );

    expect(deadlines).toEqual([1_550_000, 1_460_000, 1_550_000]);
  });

  test("keeps the sandbox across a checkpoint, unless the host is draining", async () => {
    const { deadlines, events, threadSandbox } = recorder();
    const checkpointed = async () => ({ completionStatus: "checkpointed" as const });

    await executeWithThreadSandboxRelease(
      threadSandbox,
      input("thread-persistent"),
      clock,
      checkpointed,
    );
    expect(events).toEqual([]);

    await executeWithThreadSandboxRelease(
      threadSandbox,
      input("thread-persistent"),
      { ...clock, drainDeadline: () => 1_060_000 },
      checkpointed,
    );
    expect(events).toEqual(["release"]);
    expect(deadlines).toEqual([1_060_000]);
  });

  test("releases a sandbox a checkpointed run kept, scoped to that run", async () => {
    const { released, threadSandbox } = recorder();
    const options: unknown[] = [];
    const recording: ThreadSandboxWorkspace = {
      ...threadSandbox,
      release: async (releasedScope, releaseOptions) => {
        options.push(releaseOptions);
        await threadSandbox.release(releasedScope, releaseOptions);
      },
    };
    const run = (checkpointCount: number | undefined) =>
      ({
        data: {
          ...runScope,
          agentDeploymentId: "dep",
          id: "run",
          ...(checkpointCount === undefined ? {} : { checkpointCount }),
        },
      }) as unknown as RunRecordValue;

    await releaseThreadSandboxKeptByRun(recording, run(undefined));
    await releaseThreadSandboxKeptByRun(recording, run(0));
    expect(released).toEqual([]);

    await releaseThreadSandboxKeptByRun(recording, run(2));
    expect(released).toEqual([scope]);
    expect(options).toEqual([{ onlyIfLeasedByRun: true }]);
  });

  test.each(["none", "run-ephemeral"] as const)("does not release %s runs", async (mode) => {
    const { events, threadSandbox } = recorder();

    await executeWithThreadSandboxRelease(threadSandbox, input(mode), clock, async () => done);

    expect(events).toEqual([]);
  });
});
