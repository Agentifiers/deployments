import { describe, expect, test } from "bun:test";
import type { DynamoDatabaseService, PlatformRecord, Ulid } from "@deployments-ai/db";
import { createRuntimeArtifactLifecycleBuiltinExecutors } from "./artifact-lifecycle-runtime-tools.ts";

const id = (suffix: string) => `01J000000000000000000000${suffix}` as Ulid;

describe("artifact handoff projection", () => {
  const projectedArtifact = (artifactId: Ulid) =>
    ({
      data: {
        agentDeploymentId: id("02"),
        createdAt: "2026-07-30T00:00:00.000Z",
        environmentId: id("04"),
        id: artifactId,
        name: "artifact",
        organizationId: id("05"),
        projectId: id("06"),
        runId: id("07"),
        status: "available",
        storage: {
          bucket: "artifacts",
          byteSize: 1,
          contentType: "text/plain",
          fileName: "artifact.txt",
          key: "artifact",
          sha256: "0".repeat(64),
          versionId: "v1",
        },
        type: "report",
        visibility: "private",
      },
      itemType: "artifact",
    }) as unknown as PlatformRecord;

  const execute = (
    recordedArtifactIds?: readonly Ulid[],
    projectionIds: readonly Ulid[] = [],
    input: Readonly<Record<string, unknown>> = {},
  ) => {
    const executor = createRuntimeArtifactLifecycleBuiltinExecutors({
      artifactBucket: "artifacts",
      artifactS3: { send: async () => ({}) } as never,
      database: {
        getRecord: async (_table: unknown, key: { readonly sk: string }) => {
          const artifactId = String(key.sk).replace("ARTIFACT#", "");
          const record = projectionIds.includes(artifactId as Ulid)
            ? projectedArtifact(artifactId as Ulid)
            : undefined;
          return record;
        },
        queryRecords: async () => ({
          items: projectionIds.map(projectedArtifact),
        }),
      } as unknown as DynamoDatabaseService,
      generateId: async () => id("09"),
    })["artifact.provider_handoffs.list"]!;

    return executor(
      {
        agentDefinitionId: id("01"),
        agentDeploymentId: id("02"),
        agentReleaseId: id("03"),
        decision: { action: "allow", reason: "test", toolCallId: id("09") },
        effect: "read",
        environmentId: id("04"),
        idempotencyKey: "list-handoffs",
        input,
        inputSummary: "List artifacts",
        organizationId: id("05"),
        projectId: id("06"),
        ...(recordedArtifactIds === undefined ? {} : { recordedArtifactIds }),
        requiredScopes: [],
        runId: id("07"),
        threadId: id("08"),
        toolName: "artifact.provider_handoffs.list",
      },
      {} as never,
    );
  };

  test("distinguishes a valid empty list from a missing known artifact", async () => {
    expect(execute()).resolves.toMatchObject({ status: "completed" });
    expect(execute([id("12")])).rejects.toBeInstanceOf(TypeError);
  });

  test("strongly loads every exact runtime artifact id instead of trusting the projection", async () => {
    expect(execute([id("12")], [id("13")])).rejects.toBeInstanceOf(TypeError);
    expect(execute([id("12")], [id("12")])).resolves.toMatchObject({
      status: "completed",
    });
  });

  test("returns a usable cursor for every runtime-bounded handoff artifact", async () => {
    const ids = [id("12"), id("13")];
    const first = await execute(ids, ids, { limit: 1 });
    const firstPage = JSON.parse(String(first.artifacts?.[0]?.content));
    expect(firstPage.artifacts).toEqual([expect.objectContaining({ artifactId: ids[0] })]);
    expect(firstPage.nextCursor).toBeString();

    const second = await execute([...ids, id("14")], ids, {
      cursor: firstPage.nextCursor,
      limit: 1,
    });
    const secondPage = JSON.parse(String(second.artifacts?.[0]?.content));
    expect(secondPage.artifacts).toEqual([expect.objectContaining({ artifactId: ids[1] })]);
  });
});
