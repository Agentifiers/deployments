import { describe, expect, test } from "bun:test";
import {
  AgentDeploymentRecord,
  AgentReleaseRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import {
  controlFixtures,
  deploymentId,
  environmentId,
  idGenerator,
  ids,
  memoryDatabase,
  now,
  organizationId,
  projectId,
  releaseId,
} from "./conversation-control.fixture.ts";
import { canaryBucket, createConversationService, selectAgentRelease } from "./index.ts";
import type { AgentDeployment, ConversationThread } from "./submission.ts";

const candidateId = ids[39]!;

function withCanary(deployment: AgentDeployment, weight: number | undefined): AgentDeployment {
  const {
    candidateAgentReleaseId: _candidate,
    candidateStartedAt: _startedAt,
    candidateWeight: _weight,
    ...data
  } = deployment.data;
  return Schema.decodeUnknownSync(AgentDeploymentRecord)(
    withCanonicalRecordKeys({
      data: {
        ...data,
        ...(weight === undefined
          ? {}
          : {
              candidateAgentReleaseId: candidateId,
              candidateStartedAt: now.toISOString(),
              candidateWeight: weight,
            }),
        version: deployment.data.version + 1,
      },
      itemType: "agent-deployment" as const,
    }),
  );
}

function threadPinnedTo(agentReleaseId: Ulid | undefined) {
  return {
    data: agentReleaseId ? { pinnedAgentReleaseId: agentReleaseId } : {},
  } as unknown as ConversationThread;
}

function threadIds(count: number) {
  return Array.from(
    { length: count },
    (_, index) => `01ARZ3NDEKTSV4RRFFQ${String(index).padStart(7, "0")}` as Ulid,
  );
}

describe("agent release selection", () => {
  const primaryOnly = controlFixtures().deployment;
  const canary = withCanary(primaryOnly, 30);

  test("hashes each thread into a stable bucket that splits traffic by weight", () => {
    const threads = threadIds(2_000);
    expect(canaryBucket(deploymentId, threads[0]!)).toBe(canaryBucket(deploymentId, threads[0]!));
    const candidates = threads.filter(
      (threadId) =>
        selectAgentRelease({ deployment: canary, threadId })?.releaseSelection === "candidate",
    );
    expect(candidates.length / threads.length).toBeGreaterThan(0.25);
    expect(candidates.length / threads.length).toBeLessThan(0.35);
    for (const threadId of candidates) {
      expect(canaryBucket(deploymentId, threadId)).toBeLessThan(30);
    }
  });

  test("keeps a thread's pin across weight changes until the caller rebases", () => {
    const threadId = threadIds(200).find(
      (candidate) => canaryBucket(deploymentId, candidate) >= 5,
    )!;
    const pinned = threadPinnedTo(candidateId);
    const lowWeight = withCanary(primaryOnly, 5);

    expect(selectAgentRelease({ deployment: lowWeight, thread: pinned, threadId })).toEqual({
      agentReleaseId: candidateId,
      releaseSelection: "candidate",
      threadPin: { pinnedAgentReleaseId: candidateId },
    });
    expect(
      selectAgentRelease({ deployment: lowWeight, rebaseRelease: true, thread: pinned, threadId }),
    ).toMatchObject({ agentReleaseId: releaseId, releaseSelection: "primary" });
  });

  test("falls back to the primary when the pinned release is no longer selectable", () => {
    expect(
      selectAgentRelease({
        deployment: primaryOnly,
        thread: threadPinnedTo(candidateId),
        threadId: ids[30]!,
      }),
    ).toEqual({
      agentReleaseId: releaseId,
      releaseSelection: "primary",
      threadPin: { pinnedAgentReleaseId: releaseId },
    });
    expect(
      selectAgentRelease({
        deployment: primaryOnly,
        thread: threadPinnedTo(undefined),
        threadId: ids[30]!,
      }),
    ).toEqual({ agentReleaseId: releaseId, releaseSelection: "primary", threadPin: {} });
  });

  test("accepts caller pins only from the selectable set", () => {
    expect(
      selectAgentRelease({
        deployment: canary,
        requestedAgentReleaseId: candidateId,
        threadId: ids[30]!,
      }),
    ).toMatchObject({ agentReleaseId: candidateId, releaseSelection: "candidate" });
    expect(
      selectAgentRelease({
        deployment: primaryOnly,
        requestedAgentReleaseId: candidateId,
        threadId: ids[30]!,
      }),
    ).toBeUndefined();
  });
});

describe("conversation release selection", () => {
  function setup() {
    const controls = controlFixtures();
    const candidate = Schema.decodeUnknownSync(AgentReleaseRecord)(
      withCanonicalRecordKeys({
        data: { ...controls.release.data, id: candidateId, releaseNumber: 2 },
        itemType: "agent-release" as const,
      }),
    );
    const memory = memoryDatabase([
      withCanary(controls.deployment, 99),
      controls.release,
      candidate,
    ]);
    const service = createConversationService({
      database: memory.database,
      enqueueRun: async () => {},
      generateId: idGenerator(8),
      now: () => now,
    });
    const replaceDeployment = (next: AgentDeployment) =>
      memory.records.set(
        `${tableForItemType(next.itemType)}\u0000${next.pk}\u0000${next.sk}`,
        next as PlatformRecord,
      );
    const turn = (idempotencyKey: string, extra: Record<string, unknown> = {}) =>
      service.submitTurn({
        actor: { type: "system" },
        agentDeploymentId: deploymentId,
        content: `turn ${idempotencyKey}`,
        environmentId,
        idempotencyKey,
        organizationId,
        projectId,
        ...extra,
      });
    return { controls, replaceDeployment, turn };
  }

  test("pins the thread on the canary selection and keeps it after abort only if selectable", async () => {
    const { controls, replaceDeployment, turn } = setup();
    const first = await turn("first");
    const expected =
      canaryBucket(deploymentId, first.thread.data.id) < 99 ? candidateId : releaseId;
    expect(first.run.data.agentReleaseId).toBe(expected);
    expect(first.run.data.queuedAt).toBe("2026-07-23T12:00:00.000Z");
    expect(first.run.data.releaseSelection).toBe(
      expected === candidateId ? "candidate" : "primary",
    );
    expect(first.thread.data.pinnedAgentReleaseId).toBe(expected);

    replaceDeployment(withCanary(withCanary(controls.deployment, 99), 1));
    const second = await turn("second", { threadId: first.thread.data.id });
    expect(second.run.data.agentReleaseId).toBe(expected);

    replaceDeployment(withCanary(withCanary(withCanary(controls.deployment, 99), 1), undefined));
    const afterAbort = await turn("after-abort", { threadId: first.thread.data.id });
    expect(afterAbort.run.data.agentReleaseId).toBe(releaseId);
    expect(afterAbort.run.data.releaseSelection).toBe("primary");
    expect(afterAbort.thread.data.pinnedAgentReleaseId).toBe(releaseId);
  });

  test("rejects a caller-pinned release outside the deployment's selectable set", async () => {
    const { turn } = setup();
    expect(turn("foreign", { agentReleaseId: ids[38]! })).rejects.toMatchObject({
      code: "release_unavailable",
    });
  });
});
