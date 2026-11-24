import type { MemoryPlatform } from "@deployments-ai/memory";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import { describe, expect, test } from "bun:test";
import { handleMemoryIndexQueue } from "./index-worker.ts";

const MEMORY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FA3";

describe("memory indexing of a suspended organization", () => {
  test("leaves the job unclaimed while held and indexes it after release", async () => {
    const installation = standingInstallation();
    const indexed: string[] = [];
    const platform = {
      processIndexJob: async (_scope: unknown, input: { readonly memoryId: string }) => {
        indexed.push(input.memoryId);
        return { data: { status: "succeeded" } };
      },
    } as unknown as MemoryPlatform;
    const deliver = async () => [
      await handleMemoryIndexQueue(
        {
          Records: [
            {
              attributes: { ApproximateReceiveCount: "1" },
              body: JSON.stringify({
                detail: {
                  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
                  idempotencyKey: "memory:1:7:index",
                  memoryId: MEMORY_ID,
                  organizationId: installation.organizationId,
                  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
                },
              }),
              messageId: "message-1",
              receiptHandle: "receipt-1",
            },
          ],
        },
        {
          changeVisibility: async () => {},
          now: () => new Date(),
          platform,
          random: Math.random,
          standing: installation.repository,
        },
      ),
      indexed.splice(0),
    ];

    await installation.placeHold("policy");
    const held = await deliver();
    await installation.releaseHold("policy");
    const released = await deliver();

    expect([held, released]).toEqual([
      [{ batchItemFailures: [] }, []],
      [{ batchItemFailures: [] }, [MEMORY_ID]],
    ]);
  });
});
