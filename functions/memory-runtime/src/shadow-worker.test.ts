import { describe, expect, test } from "bun:test";
import type { MemoryPlatform } from "@deployments-ai/memory";
import { handleMemoryShadowQueue } from "./shadow-worker.ts";

const ids = {
  environment: "01ARZ3NDEKTSV4RRFFQ69G5FA2",
  organization: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
  project: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
  space: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
};

describe("memory shadow worker", () => {
  test("executes an expiring shadow job without receiving query plaintext", async () => {
    const jobs: unknown[] = [];
    const platform = {
      executeShadowJob: async (scope: unknown, jobId: unknown) => {
        jobs.push({ jobId, scope });
        return {} as never;
      },
    } as unknown as MemoryPlatform;
    const result = await handleMemoryShadowQueue(
      {
        Records: [
          {
            body: JSON.stringify({
              detail: {
                environmentId: ids.environment,
                organizationId: ids.organization,
                payload: {
                  jobId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
                },
                projectId: ids.project,
              },
            }),
            messageId: "shadow-1",
          },
        ],
      },
      { platform },
    );
    expect(result.batchItemFailures).toEqual([]);
    expect(jobs).toEqual([
      {
        jobId: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
        scope: {
          environmentId: ids.environment,
          organizationId: ids.organization,
          projectId: ids.project,
        },
      },
    ]);
    expect(JSON.stringify(jobs)).not.toContain("deployment marker");
  });
});
