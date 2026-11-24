import { RuntimeArtifactPublicationError } from "@deployments-ai/agent-runtime";
import { describe, expect, it, spyOn } from "bun:test";
import {
  HoldKey,
  Keys,
  RunRecord,
  StandingActor,
  makeOrganizationStandingRepository,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type HoldReason,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { processAgentRun } from "./index.ts";
import type { AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";
import {
  abandonedRunWithLease,
  fixtures,
  inMemoryDatabase,
  workerDependencies,
} from "./agent-run.fixture.ts";

const HOLD = {
  actor: Schema.decodeUnknownSync(StandingActor)({
    kind: "operator",
    principalId: "01J9ZQ5Y5V7Q8R3X2K4M6N8P0B",
  }),
  key: Schema.decodeUnknownSync(HoldKey)("review"),
};

function standing(database: DynamoDatabaseService, organizationId: Ulid) {
  const repository = makeOrganizationStandingRepository({
    database,
    installDefaults: {
      operatorFundedModelSpendCeiling: "unlimited",
      tenantLimits: {
        activeSandboxes: 1,
        apiRequestBurst: 40,
        apiRequestsPerSecond: 20,
        concurrentRuns: 2,
      },
    },
  });
  const scope = { ...HOLD, organizationId };
  return {
    hold: (reason: HoldReason) =>
      repository.placeHold({ ...scope, customerMessage: "Held for review.", reason }),
    release: () => repository.releaseHold(scope),
  };
}

function storedRun(records: ReadonlyMap<string, PlatformRecord>) {
  const run = [...records.values()].find((record) => record.itemType === "run");
  return run?.itemType === "run" ? run.data : undefined;
}

function count(records: ReadonlyMap<string, PlatformRecord>, itemType: PlatformRecord["itemType"]) {
  return [...records.values()].filter((record) => record.itemType === itemType).length;
}

function isHeartbeat(operation: TransactionOperation) {
  return (
    operation.kind === "put" &&
    operation.record.itemType === "semantic-event" &&
    operation.record.data.eventType === "run.heartbeat"
  );
}

/** Resolves `renewals(n)` once n more claim renewals have committed. */
function watchRenewals(database: DynamoDatabaseService) {
  let committed = 0;
  const waiters: { readonly count: number; readonly resolve: () => void }[] = [];
  const watched: DynamoDatabaseService = {
    ...database,
    transactWrite: async (operations, token, signal) => {
      await database.transactWrite(operations, token, signal);
      if (!operations.some(isHeartbeat)) return;
      committed += 1;
      for (const waiter of waiters.filter((candidate) => candidate.count <= committed)) {
        waiter.resolve();
      }
    },
  };
  return {
    committed: () => committed,
    database: watched,
    renewals: (more: number) =>
      new Promise<void>((resolve) => waiters.push({ count: committed + more, resolve })),
  };
}

/**
 * Hooks reads of the organization's standing record: `failNext(n)` fails the next n reads, and
 * `afterNextRead(action)` runs an action once the next read has returned.
 */
function standingReads(database: DynamoDatabaseService, organizationId: Ulid) {
  const standingKey = Keys.control.organizationStanding(organizationId);
  let failures = 0;
  let pending: (() => Promise<unknown>) | undefined;
  const hooked: DynamoDatabaseService = {
    ...database,
    getRecord: async (table, recordKey, consistentRead) => {
      if (
        table !== "control" ||
        recordKey.pk !== standingKey.pk ||
        recordKey.sk !== standingKey.sk
      ) {
        return database.getRecord(table, recordKey, consistentRead);
      }
      if (failures > 0) {
        failures -= 1;
        throw new Error("Organization standing read timed out.");
      }
      const record = await database.getRecord(table, recordKey, consistentRead);
      const action = pending;
      pending = undefined;
      await action?.();
      return record;
    },
  };
  return {
    afterNextRead: (action: () => Promise<unknown>) => {
      pending = action;
    },
    database: hooked,
    failNext: (count: number) => {
      failures = count;
    },
  };
}

function requeuedAfterCheckpoint(run: RunRecordValue) {
  return Schema.decodeUnknownSync(RunRecord)(
    withCanonicalRecordKeys({
      data: {
        ...run.data,
        attempt: 1,
        checkpointCount: 1,
        startedAt: "2026-07-22T00:00:00.000Z",
        version: 1,
      },
      itemType: "run" as const,
    }),
  );
}

type Seed = "queued" | "requeued-after-checkpoint" | "abandoned-while-running";

function seededRun(seed: Seed = "queued") {
  const fixture = fixtures();
  const runRecords: Record<Seed, () => readonly PlatformRecord[]> = {
    "abandoned-while-running": () => {
      const { lease, run } = abandonedRunWithLease(fixture);
      return [run, lease];
    },
    queued: () => [fixture.run],
    "requeued-after-checkpoint": () => [requeuedAfterCheckpoint(fixture.run)],
  };
  const memory = inMemoryDatabase([
    fixture.release,
    fixture.deployment,
    fixture.thread,
    fixture.userMessage,
    ...runRecords[seed](),
  ]);
  const reads = standingReads(memory.database, fixture.run.data.organizationId);
  const watch = watchRenewals(reads.database);
  return {
    fixture,
    memory,
    reads,
    standing: standing(memory.database, fixture.run.data.organizationId),
    watch,
  };
}

async function abortOf(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) throw new Error("The run was executed without an abort signal.");
  if (!signal.aborted) {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  }
  throw signal.reason;
}

describe("organization standing at claim and heartbeat", () => {
  for (const reason of ["payment", "abuse"] as const) {
    it(`fails a queued run at claim, before it takes capacity, while held for ${reason}`, async () => {
      const { fixture, memory, standing } = seededRun();
      await standing.hold(reason);
      const base = workerDependencies(memory.database);
      const dependencies: AgentRunWorkerDependencies = {
        ...base.dependencies,
        runtime: {
          generateAssistantMessage: async () => {
            throw new Error("A suspended organization's queued run must not execute.");
          },
        },
      };

      const result = await processAgentRun(fixture.queue, dependencies);
      const run = storedRun(memory.records);

      expect(result).toMatchObject({
        action: "skipped",
        reason: "Run's organization is suspended.",
      });
      expect([run?.status, run?.error, run?.claimedBy]).toEqual([
        "failed",
        {
          code: "organization_suspended",
          message: "The run was stopped at claim because its organization is suspended.",
        },
        undefined,
      ]);
      expect([
        count(memory.records, "unique-claim"),
        count(memory.records, "runtime-lease"),
      ]).toEqual([0, 0]);
    });
  }

  it("keeps a never-started run from starting when a payment hold lands after the claim's standing read", async () => {
    const { fixture, memory, reads, standing } = seededRun();
    reads.afterNextRead(() => standing.hold("payment"));
    const base = workerDependencies(reads.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async () => {
          throw new Error("A run claimed under a payment hold must not execute.");
        },
      },
    };

    const outcome = await processAgentRun(fixture.queue, dependencies).then(
      (result) => result.action,
      (cause: unknown) => (cause instanceof Error ? cause.name : String(cause)),
    );

    expect([
      outcome,
      storedRun(memory.records)?.status,
      count(memory.records, "unique-claim"),
      count(memory.records, "runtime-lease"),
    ]).toEqual(["DatabaseError", "queued", 0, 0]);
  });

  it("admits a queued run again once its organization's hold is released", async () => {
    const { fixture, memory, standing } = seededRun();
    await standing.hold("abuse");
    await standing.release();
    const base = workerDependencies(memory.database);

    const result = await processAgentRun(fixture.queue, base.dependencies);

    expect([result.action, storedRun(memory.records)?.status]).toEqual(["completed", "completed"]);
  });

  it("cancels a running run at its next heartbeat when an abuse hold stops the organization", async () => {
    const { fixture, memory, standing, watch } = seededRun();
    const base = workerDependencies(watch.database);
    let renewalsAfterHold = -1;
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      heartbeatIntervalMs: 5,
      runningClaimTimeoutMs: 1_000,
      runtime: {
        generateAssistantMessage: async (request) => {
          await watch.renewals(1);
          await standing.hold("abuse");
          renewalsAfterHold = watch.committed();
          return abortOf(request.signal);
        },
      },
    };

    const result = await processAgentRun(fixture.queue, dependencies);
    const run = storedRun(memory.records);

    expect(result).toMatchObject({ action: "skipped" });
    expect([run?.status, run?.error, run?.claimedBy]).toEqual([
      "canceled",
      {
        code: "organization_suspended",
        message: "The run was canceled because its organization was suspended.",
      },
      undefined,
    ]);
    expect(watch.committed()).toBe(renewalsAfterHold);
    expect(count(memory.records, "runtime-lease")).toBe(0);
  });

  it("keeps renewing a running run under a payment hold so it drains to completion", async () => {
    const { fixture, memory, standing, watch } = seededRun();
    const base = workerDependencies(watch.database);
    const dependencies: AgentRunWorkerDependencies = {
      ...base.dependencies,
      heartbeatIntervalMs: 5,
      runningClaimTimeoutMs: 1_000,
      runtime: {
        generateAssistantMessage: async (request) => {
          await standing.hold("payment");
          await watch.renewals(3);
          expect(request.signal?.aborted).toBe(false);
          return { assistantMessage: "Drained under a payment hold." };
        },
      },
    };

    const result = await processAgentRun(fixture.queue, dependencies);

    expect([result.action, storedRun(memory.records)?.status]).toEqual(["completed", "completed"]);
  });

  for (const seed of ["requeued-after-checkpoint", "abandoned-while-running"] as const) {
    it(`claims a run ${seed} under a payment hold so it drains to completion`, async () => {
      const { fixture, memory, standing } = seededRun(seed);
      await standing.hold("payment");
      const base = workerDependencies(memory.database);

      const result = await processAgentRun(fixture.queue, {
        ...base.dependencies,
        runningClaimTimeoutMs: 50,
      });

      expect([result.action, storedRun(memory.records)?.status]).toEqual([
        "completed",
        "completed",
      ]);
    });

    it(`fails a run ${seed} at claim under an abuse hold`, async () => {
      const { fixture, memory, standing } = seededRun(seed);
      await standing.hold("abuse");
      const base = workerDependencies(memory.database);

      const result = await processAgentRun(fixture.queue, {
        ...base.dependencies,
        runningClaimTimeoutMs: 50,
      });
      const run = storedRun(memory.records);

      expect(result).toMatchObject({
        action: "skipped",
        reason: "Run's organization is suspended.",
      });
      expect([run?.status, run?.error?.code, count(memory.records, "runtime-lease")]).toEqual([
        "failed",
        "organization_suspended",
        0,
      ]);
    });
  }

  for (const [seed, unclaimedStatus] of [
    ["requeued-after-checkpoint", "queued"],
    ["abandoned-while-running", "running"],
  ] as const) {
    it(`keeps a run ${seed} from being claimed when an abuse hold lands after the claim's standing read`, async () => {
      const { fixture, memory, reads, standing } = seededRun(seed);
      reads.afterNextRead(() => standing.hold("abuse"));
      const base = workerDependencies(reads.database);
      let executed = false;

      const outcome = await processAgentRun(fixture.queue, {
        ...base.dependencies,
        runningClaimTimeoutMs: 50,
        runtime: {
          generateAssistantMessage: async () => {
            executed = true;
            return { assistantMessage: "Ran under an abuse hold." };
          },
        },
      }).then(
        (result) => result.action,
        (cause: unknown) => (cause instanceof Error ? cause.name : String(cause)),
      );

      expect([outcome, executed, storedRun(memory.records)?.status]).toEqual([
        "DatabaseError",
        false,
        unclaimedStatus,
      ]);
    });
  }

  it("claims a run requeued by a retryable failure under a payment hold so it drains to completion", async () => {
    const { fixture, memory, standing } = seededRun();
    const base = workerDependencies(memory.database);

    const requeued = await processAgentRun(fixture.queue, {
      ...base.dependencies,
      runtime: {
        generateAssistantMessage: async () => {
          throw new RuntimeArtifactPublicationError("stream unavailable");
        },
      },
    });
    await standing.hold("payment");
    const drained = await processAgentRun(fixture.queue, base.dependencies);

    expect([requeued.action, drained.action, storedRun(memory.records)?.status]).toEqual([
      "requeued",
      "completed",
      "completed",
    ]);
  });

  for (const [failedReads, expected] of [
    [1, { logged: 0, outcome: "skipped", status: "canceled" }],
    [2, { logged: 1, outcome: "DatabaseError", status: "running" }],
  ] as const) {
    it(`retries the standing read once after a refused renewal: ${failedReads} failed read(s)`, async () => {
      const { fixture, memory, reads, standing, watch } = seededRun();
      const base = workerDependencies(watch.database);
      const errors = spyOn(console, "error").mockImplementation(() => {});
      const dependencies: AgentRunWorkerDependencies = {
        ...base.dependencies,
        heartbeatIntervalMs: 5,
        runningClaimTimeoutMs: 1_000,
        runtime: {
          generateAssistantMessage: async (request) => {
            await watch.renewals(1);
            await standing.hold("abuse");
            reads.failNext(failedReads);
            return abortOf(request.signal);
          },
        },
      };

      let logged: number;
      let outcome: string;
      try {
        outcome = await processAgentRun(fixture.queue, dependencies).then(
          (result) => result.action,
          (cause: unknown) => (cause instanceof Error ? cause.name : String(cause)),
        );
        logged = errors.mock.calls.filter(
          ([message]) =>
            message ===
            "Organization standing could not be read after a claim renewal failed; the run was not canceled.",
        ).length;
      } finally {
        errors.mockRestore();
      }

      expect({ logged, outcome, status: storedRun(memory.records)?.status }).toEqual(expected);
    });
  }
});
