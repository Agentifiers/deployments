import { describe, expect, test } from "bun:test";
import type { PlatformRecord } from "@deployments-ai/db";
import {
  enqueueExternalPublicationSettledRecovery,
  externalPublicationRecoveryQueueMessage,
} from "./external-publication-recovery.ts";
import { agentRunQueueMessageGroupId, type AgentRunQueueEnqueueInput } from "./types.ts";
import { fixtures } from "./agent-run.fixture.ts";

function completedRun() {
  const fixture = fixtures();
  return {
    ...fixture.run,
    data: {
      ...fixture.run.data,
      completedAt: "2026-09-03T00:00:00.000Z",
      responsePublication: "external" as const,
      status: "completed" as const,
      userMessageId: fixture.queue.userMessageId,
      userMessageSequence: fixture.queue.userMessageSequence,
    },
  } as Extract<PlatformRecord, { readonly itemType: "run" }>;
}

function settledPublication(status: "published" | "released") {
  const fixture = fixtures();
  return {
    data: {
      agentDeploymentId: fixture.deployment.data.id,
      environmentId: fixture.queue.environmentId,
      id: "01J00000000000000000000020",
      organizationId: fixture.queue.organizationId,
      projectId: fixture.queue.projectId,
      runId: fixture.queue.runId,
      status,
      threadId: fixture.queue.threadId,
      version: status === "published" ? 2 : 1,
    },
    itemType: "message-publication" as const,
  } as Extract<PlatformRecord, { readonly itemType: "message-publication" }>;
}

describe("external publication checkpoint recovery", () => {
  test.each(["published", "released"] as const)(
    "queues a deterministic recovery after a publication is %s",
    async (status) => {
      const enqueued: AgentRunQueueEnqueueInput[] = [];
      const run = completedRun();
      const publication = settledPublication(status);

      await enqueueExternalPublicationSettledRecovery(
        async (input) => void enqueued.push(input),
        run,
        publication,
      );

      const message = externalPublicationRecoveryQueueMessage(run);
      expect(enqueued).toEqual([
        {
          deduplicationId: `external-publication-settled:${publication.data.id}:${publication.data.version}`,
          message,
          messageGroupId: agentRunQueueMessageGroupId(message),
        },
      ]);
      expect(message.recoveryReason).toBe("external-publication-settled");
    },
  );

  test("rejects an unsettled publication", async () => {
    expect(
      enqueueExternalPublicationSettledRecovery(async () => undefined, completedRun(), {
        ...settledPublication("released"),
        data: { ...settledPublication("released").data, status: "reserved" },
      } as Extract<PlatformRecord, { readonly itemType: "message-publication" }>),
    ).rejects.toThrow("must be published or released");
  });
});
