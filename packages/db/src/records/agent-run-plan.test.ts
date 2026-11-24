import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import { AgentRunPlanRecord } from "./runtime-work.ts";
import { withCanonicalRecordKeys } from "./index.ts";

const id = (suffix: string) =>
  Schema.decodeUnknownSync(Ulid)(`01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}`);

function data() {
  return {
    agentDeploymentId: id("1"),
    createdAt: "2026-08-12T12:00:00.000Z",
    environmentId: id("2"),
    id: id("3"),
    organizationId: id("4"),
    planRevision: 1,
    projectId: id("5"),
    runAttempt: 0,
    runClaimedAt: "2026-08-12T12:00:00.000Z",
    runExecutionVersion: 1,
    runId: id("3"),
    tasks: [
      {
        id: "produce-response",
        order: 0,
        status: "pending" as const,
        title: "Produce the response",
      },
    ],
    threadId: id("6"),
    title: "Complete the request",
    traceId: "0123456789abcdef0123456789abcdef",
    updatedAt: "2026-08-12T12:00:00.000Z",
    version: 0,
  };
}

describe("agent run plan record", () => {
  test("uses one canonical run-scoped identity", () => {
    const record = Schema.decodeUnknownSync(AgentRunPlanRecord)(
      withCanonicalRecordKeys({ data: data(), itemType: "agent-run-plan" as const }),
    );
    expect(record.pk).toBe(`ORG#${id("4")}#RUN#${id("3")}`);
    expect(record.sk).toBe(`AGENT-RUN-PLAN#${id("3")}`);
  });

  test("rejects duplicate task identities, invalid status, and oversized text", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgentRunPlanRecord)(
        withCanonicalRecordKeys({
          data: { ...data(), tasks: [...data().tasks, { ...data().tasks[0]!, order: 1 }] },
          itemType: "agent-run-plan" as const,
        }),
      ),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AgentRunPlanRecord)(
        withCanonicalRecordKeys({
          data: { ...data(), tasks: [{ ...data().tasks[0]!, status: "blocked" }] },
          itemType: "agent-run-plan" as const,
        }),
      ),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AgentRunPlanRecord)(
        withCanonicalRecordKeys({
          data: { ...data(), title: "x".repeat(257) },
          itemType: "agent-run-plan" as const,
        }),
      ),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(AgentRunPlanRecord)(
        withCanonicalRecordKeys({
          data: { ...data(), planRevision: 0 },
          itemType: "agent-run-plan" as const,
        }),
      ),
    ).toThrow();
  });
});
