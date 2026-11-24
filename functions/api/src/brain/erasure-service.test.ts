import { describe, expect, test } from "bun:test";
import type { BrainErasure } from "@deployments-ai/brains";
import {
  brain,
  brainId,
  invocation,
  organizationId,
  principalId,
  repository,
  service,
  timestamp,
} from "./service.fixture.ts";

const erasureId = "01ARZ3NDEKTSV4RRFFQ69G5FB5";
const eventId = "01ARZ3NDEKTSV4RRFFQ69G5FB6";

describe("Brain API erasure lifecycle", () => {
  test("atomically begins a human-owner erasure against the next Brain generation", async () => {
    let observed: BrainErasure | undefined;
    const api = service(
      {
        repository: repository({
          beginErasure: async ({ brain: fenced, erasure }) => {
            expect(fenced).toMatchObject({ status: "erasing", version: brain.version + 1 });
            observed = erasure;
            return erasure;
          },
        }),
      },
      [erasureId, eventId],
    );

    const result = await api.invoke(
      "eraseBrain",
      invocation({ body: { expectedVersion: brain.version } }),
    );

    expect(result).toMatchObject({
      brainId,
      contentVerificationCount: 0,
      erasureGeneration: brain.version + 1,
      id: erasureId,
      organizationId,
      status: "pending",
    });
    expect(observed).toMatchObject({
      phase: "draining",
      requestedByPrincipalId: principalId,
    });
  });

  test("lets the initiating active member poll the retained receipt after the Brain is gone", async () => {
    const completed: BrainErasure = {
      brainId,
      completedAt: timestamp,
      contentVerificationCount: 2,
      createdAt: timestamp,
      erasureGeneration: 1,
      id: erasureId,
      nextDueAt: timestamp,
      organizationId,
      phase: "verifying",
      priority: 0,
      recordsDeleted: 42,
      requestedByPrincipalId: principalId,
      searchReceipt: { absenceVerified: true },
      status: "completed",
      updatedAt: timestamp,
      version: 4,
    };
    const api = service({
      repository: repository({
        get: async () => undefined,
        getErasure: async () => completed,
      }),
    });

    expect(
      api.invoke("getBrainErasure", invocation({ params: { brainId, erasureId } })),
    ).resolves.toMatchObject({ id: erasureId, recordsDeleted: 42, status: "completed" });
  });

  test("replays the deterministic erasure operation if API idempotency completion was interrupted", async () => {
    let stored: BrainErasure | undefined;
    let begins = 0;
    const api = service(
      {
        repository: repository({
          beginErasure: async ({ erasure }) => {
            begins += 1;
            stored = erasure;
            return erasure;
          },
          getErasure: async (_organizationId, _brainId, candidateId) =>
            stored?.id === candidateId ? stored : undefined,
        }),
      },
      [eventId],
    );
    const request = invocation({
      body: { expectedVersion: brain.version },
      idempotencyKey: "erase-once",
    });

    const first = await api.invoke("eraseBrain", request);
    const replay = await api.invoke("eraseBrain", request);

    expect(replay).toEqual(first);
    expect(begins).toBe(1);
  });
});
