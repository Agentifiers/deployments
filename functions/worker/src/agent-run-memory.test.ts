import { describe, expect, it } from "bun:test";
import type { RuntimeMemoryMode } from "@deployments-ai/agent-runtime";
import type { RunRecordValue } from "./types.ts";
import { ensureCompletedRunMemoryFlush } from "./agent-run-memory.ts";
import {
  fixtures,
  inMemoryDatabase,
  releaseWithManifest,
  workerDependencies,
} from "./agent-run.fixture.ts";

function completedRun(trigger: RunRecordValue["data"]["trigger"]): RunRecordValue {
  const fixture = fixtures();
  return {
    ...fixture.run,
    data: {
      ...fixture.run.data,
      completedAt: "2026-07-22T00:00:01.000Z",
      status: "completed",
      trigger,
    },
  } as RunRecordValue;
}

function externallyPublishedRun(
  trigger: RunRecordValue["data"]["trigger"] = "chat",
): RunRecordValue {
  const run = completedRun(trigger);
  return {
    ...run,
    data: {
      ...run.data,
      responsePublication: "external",
    },
  } as RunRecordValue;
}

describe("completed run memory flush", () => {
  it("enqueues enabled memory for ordinary completed runs", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([]);
    const { dependencies } = workerDependencies(memory.database);
    const calls: {
      memoryMode: RuntimeMemoryMode;
      reviewMode: string | undefined;
      runId: string;
    }[] = [];

    await ensureCompletedRunMemoryFlush(
      {
        ...dependencies,
        enqueueMemoryFlush: async (run, memoryMode, _checkpointMode, reviewMode) => {
          calls.push({ memoryMode, reviewMode, runId: run.data.id });
          return "enqueued";
        },
      },
      completedRun("api"),
      "agent",
      fixture.queue,
      "off",
      "auto-approve",
      fixture.release.data.manifest.spec.model.id,
    );

    expect(calls).toEqual([
      { memoryMode: "agent", reviewMode: "auto-approve", runId: fixture.run.data.id },
    ]);
  });

  it.each(["heartbeat", "schedule"] as const)(
    "does not extract relationship memory from %s runs",
    async (trigger) => {
      const fixture = fixtures();
      const memory = inMemoryDatabase([]);
      const { dependencies } = workerDependencies(memory.database);
      let enqueued = false;

      await ensureCompletedRunMemoryFlush(
        {
          ...dependencies,
          enqueueMemoryFlush: async () => {
            enqueued = true;
            return "enqueued";
          },
        },
        completedRun(trigger),
        "agent",
        fixture.queue,
      );

      expect(enqueued).toBe(false);
    },
  );

  it("loads the model when callers already know the memory and checkpoint policies", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(fixture.release, {
      ...fixture.release.data.manifest,
      spec: {
        ...fixture.release.data.manifest.spec,
        memory: { mode: "agent", reviewMode: "auto-approve" },
      },
    });
    const memory = inMemoryDatabase([release]);
    const { dependencies } = workerDependencies(memory.database);
    const calls: {
      readonly modelId: string | undefined;
      readonly reviewMode: string | undefined;
    }[] = [];

    await ensureCompletedRunMemoryFlush(
      {
        ...dependencies,
        enqueueMemoryFlush: async (_run, _memoryMode, _checkpointMode, reviewMode, modelId) => {
          calls.push({ modelId, reviewMode });
          return "enqueued";
        },
      },
      completedRun("api"),
      "agent",
      fixture.queue,
      "off",
      "auto-approve",
    );

    expect(calls).toEqual([
      {
        modelId: release.data.manifest.spec.model.id,
        reviewMode: "auto-approve",
      },
    ]);
  });

  it("leaves an unset manifest review mode for the memory platform to resolve", async () => {
    const fixture = fixtures();
    const release = releaseWithManifest(fixture.release, {
      ...fixture.release.data.manifest,
      spec: { ...fixture.release.data.manifest.spec, memory: { mode: "workspace" } },
    });
    const memory = inMemoryDatabase([release]);
    const { dependencies } = workerDependencies(memory.database);
    const reviewModes: (string | undefined)[] = [];

    await ensureCompletedRunMemoryFlush(
      {
        ...dependencies,
        enqueueMemoryFlush: async (_run, _memoryMode, _checkpointMode, reviewMode) => {
          reviewModes.push(reviewMode);
          return "enqueued";
        },
      },
      completedRun("api"),
      undefined,
      fixture.queue,
    );

    expect(reviewModes).toEqual([undefined]);
  });

  it("does not enqueue when memory is disabled", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([]);
    const { dependencies } = workerDependencies(memory.database);
    let enqueued = false;

    await ensureCompletedRunMemoryFlush(
      {
        ...dependencies,
        enqueueMemoryFlush: async () => {
          enqueued = true;
          return "enqueued";
        },
      },
      completedRun("api"),
      "off",
      fixture.queue,
      "off",
    );

    expect(enqueued).toBe(false);
  });

  it("enqueues automatic checkpoints when relationship memory is disabled", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([]);
    const { dependencies } = workerDependencies(memory.database);
    const calls: { checkpointMode?: "auto" | "off"; memoryMode: RuntimeMemoryMode }[] = [];

    await ensureCompletedRunMemoryFlush(
      {
        ...dependencies,
        enqueueMemoryFlush: async (_run, memoryMode, checkpointMode) => {
          calls.push({ ...(checkpointMode ? { checkpointMode } : {}), memoryMode });
          return "enqueued";
        },
      },
      completedRun("api"),
      "off",
      fixture.queue,
      "auto",
      undefined,
      fixture.release.data.manifest.spec.model.id,
    );

    expect(calls).toEqual([{ checkpointMode: "auto", memoryMode: "off" }]);
  });

  it("defers externally published runs until delivery publication settles", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([]);
    const { dependencies } = workerDependencies(memory.database);
    let enqueued = false;

    const result = await ensureCompletedRunMemoryFlush(
      {
        ...dependencies,
        enqueueMemoryFlush: async () => {
          enqueued = true;
          return "enqueued";
        },
      },
      externallyPublishedRun(),
      "agent",
      fixture.queue,
      "auto",
      "auto-approve",
      fixture.release.data.manifest.spec.model.id,
    );

    expect(result).toBe("skipped");
    expect(enqueued).toBe(false);
  });

  it("checkpoints an externally published run after delivery publication settles", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([]);
    const { dependencies } = workerDependencies(memory.database);
    const calls: {
      checkpointMode?: "auto" | "off";
      memoryMode: RuntimeMemoryMode;
      reviewMode?: string;
    }[] = [];

    await ensureCompletedRunMemoryFlush(
      {
        ...dependencies,
        enqueueMemoryFlush: async (_run, memoryMode, checkpointMode, reviewMode) => {
          calls.push({
            ...(checkpointMode ? { checkpointMode } : {}),
            memoryMode,
            ...(reviewMode ? { reviewMode } : {}),
          });
          return "enqueued";
        },
      },
      externallyPublishedRun(),
      "agent",
      { ...fixture.queue, recoveryReason: "external-publication-settled" },
      "auto",
      "auto-approve",
      fixture.release.data.manifest.spec.model.id,
    );

    expect(calls).toEqual([
      { checkpointMode: "auto", memoryMode: "agent", reviewMode: "auto-approve" },
    ]);
  });

  it("requeues an externally published checkpoint for thread continuity recovery", async () => {
    const fixture = fixtures();
    const memory = inMemoryDatabase([]);
    const { dependencies } = workerDependencies(memory.database);
    const calls: { checkpointMode?: "auto" | "off"; memoryMode: RuntimeMemoryMode }[] = [];

    await ensureCompletedRunMemoryFlush(
      {
        ...dependencies,
        enqueueMemoryFlush: async (_run, memoryMode, checkpointMode) => {
          calls.push({ ...(checkpointMode ? { checkpointMode } : {}), memoryMode });
          return "enqueued";
        },
      },
      externallyPublishedRun(),
      "agent",
      { ...fixture.queue, recoveryReason: "thread-continuity-recovery" },
      "auto",
      "auto-approve",
      fixture.release.data.manifest.spec.model.id,
    );

    expect(calls).toEqual([{ checkpointMode: "auto", memoryMode: "agent" }]);
  });

  it.each(["heartbeat", "schedule"] as const)(
    "checkpoints settled %s publications without extracting relationship memory",
    async (trigger) => {
      const fixture = fixtures();
      const release = releaseWithManifest(fixture.release, {
        ...fixture.release.data.manifest,
        spec: {
          ...fixture.release.data.manifest.spec,
          memory: { mode: "agent", reviewMode: "auto-approve" },
          runtime: {
            ...fixture.release.data.manifest.spec.runtime,
            contextCheckpointMode: "auto",
          },
        },
      });
      const memory = inMemoryDatabase([release]);
      const { dependencies } = workerDependencies(memory.database);
      const calls: {
        checkpointMode?: "auto" | "off";
        memoryMode: RuntimeMemoryMode;
        reviewMode?: string;
      }[] = [];

      await ensureCompletedRunMemoryFlush(
        {
          ...dependencies,
          enqueueMemoryFlush: async (_run, memoryMode, checkpointMode, reviewMode) => {
            calls.push({
              ...(checkpointMode ? { checkpointMode } : {}),
              memoryMode,
              ...(reviewMode ? { reviewMode } : {}),
            });
            return "enqueued";
          },
        },
        completedRun(trigger),
        undefined,
        { ...fixture.queue, recoveryReason: "external-publication-settled" },
      );

      expect(calls).toEqual([
        { checkpointMode: "auto", memoryMode: "off", reviewMode: "auto-approve" },
      ]);
    },
  );
});
