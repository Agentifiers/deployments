import { describe, expect, test } from "bun:test";
import type { DynamoDatabaseService, PlatformRecord, Ulid } from "@deployments-ai/db";
import { sourceRunArtifacts } from "./artifact-source-run.ts";

type Artifact = Extract<PlatformRecord, { readonly itemType: "artifact" }>;
const id = (suffix: string) => `01J000000000000000000000${suffix}` as Ulid;
const request = {
  agentDefinitionId: id("01"),
  agentDeploymentId: id("02"),
  agentReleaseId: id("03"),
  decision: { action: "allow" as const, reason: "test", toolCallId: id("09") },
  effect: "read" as const,
  environmentId: id("04"),
  idempotencyKey: "source-run-test",
  inputSummary: "List source artifacts",
  organizationId: id("05"),
  projectId: id("06"),
  requiredScopes: [],
  runId: id("07"),
  threadId: id("08"),
  toolName: "artifact.source_run",
};

function artifact(artifactId: Ulid, sequence: number): Artifact {
  return {
    data: {
      agentDeploymentId: request.agentDeploymentId,
      createdAt: `2026-07-30T00:00:0${sequence}.000Z`,
      environmentId: request.environmentId,
      id: artifactId,
      metadata: { large: "x".repeat(100_000) },
      name: `artifact-${sequence}`,
      organizationId: request.organizationId,
      projectId: request.projectId,
      runId: request.runId,
      status: "available",
      storage: {
        bucket: "artifacts",
        byteSize: sequence,
        contentType: "text/plain",
        fileName: `artifact-${sequence}.txt`,
        key: `artifact-${sequence}`,
        sha256: "0".repeat(64),
        versionId: "v1",
      },
      type: "report",
      visibility: "private",
    },
    gsi1pk: `ORG#${request.organizationId}#RUN#${request.runId}#ARTIFACTS`,
    gsi1sk: `ARTIFACT#available#2026-07-30T00:00:0${sequence}.000Z#${artifactId}`,
    itemType: "artifact",
    pk: `ORG#${request.organizationId}#ENV#${request.environmentId}`,
    sk: `ARTIFACT#${artifactId}`,
  } as unknown as Artifact;
}

function value(result: Awaited<ReturnType<typeof sourceRunArtifacts>>) {
  return JSON.parse(String(result.artifacts?.[0]?.content)) as {
    readonly artifacts: readonly Readonly<Record<string, unknown>>[];
    readonly nextCursor?: string;
  };
}

describe("source-run artifact listing", () => {
  test("strongly loads exact current-run artifacts before their GSI projection is visible", async () => {
    const first = artifact(id("10"), 1);
    const second = artifact(id("11"), 2);
    const records = new Map<string, Artifact>([
      [first.data.id, first],
      [second.data.id, second],
    ]);
    const options = {
      artifactBucket: "artifacts",
      artifactS3: { send: async () => ({}) } as never,
      database: {
        getRecord: async (_table: unknown, recordKey: { readonly sk: string }) =>
          records.get(recordKey.sk.replace("ARTIFACT#", "")),
        queryRecords: async () => ({ items: [] }),
      } as unknown as DynamoDatabaseService,
      generateId: async () => id("19"),
    };

    const pageOne = value(
      await sourceRunArtifacts(options, {
        ...request,
        input: { limit: 1, sourceRunId: request.runId },
        recordedArtifactIds: [first.data.id, second.data.id],
      }),
    );
    expect(pageOne.artifacts).toEqual([
      expect.objectContaining({ artifactId: first.data.id, name: "artifact-1" }),
    ]);
    expect(pageOne.artifacts[0]).not.toHaveProperty("metadata");
    expect(pageOne.nextCursor).toBeString();

    const pageTwo = value(
      await sourceRunArtifacts(options, {
        ...request,
        input: { cursor: pageOne.nextCursor, limit: 1, sourceRunId: request.runId },
        recordedArtifactIds: [first.data.id, second.data.id, id("16")],
      }),
    );
    expect(pageTwo.artifacts).toEqual([
      expect.objectContaining({ artifactId: second.data.id, name: "artifact-2" }),
    ]);
    const pageThree = value(
      await sourceRunArtifacts(options, {
        ...request,
        input: { cursor: pageTwo.nextCursor, limit: 1, sourceRunId: request.runId },
        recordedArtifactIds: [first.data.id, second.data.id, id("16"), id("17")],
      }),
    );
    expect(pageThree).toEqual({ artifacts: [] });
  });

  test("paginates compact GSI results with a source-bound cursor", async () => {
    const newest = artifact(id("12"), 2);
    const oldest = artifact(id("13"), 1);
    const options = {
      artifactBucket: "artifacts",
      artifactS3: { send: async () => ({}) } as never,
      database: {
        getRecord: async () => undefined,
        queryRecords: async (
          _table: unknown,
          input: { readonly ExpressionAttributeValues?: Readonly<Record<string, unknown>> },
        ) => {
          const cursor = input.ExpressionAttributeValues?.[":sk"];
          return {
            items: cursor === "ARTIFACT#" ? [newest, oldest] : [oldest],
          };
        },
      } as unknown as DynamoDatabaseService,
      generateId: async () => id("19"),
    };

    const pageOne = value(
      await sourceRunArtifacts(options, {
        ...request,
        input: { limit: 1, sourceRunId: request.runId },
      }),
    );
    expect(pageOne.artifacts[0]).toMatchObject({ artifactId: newest.data.id });
    expect(pageOne.nextCursor).toBeString();

    const pageTwo = value(
      await sourceRunArtifacts(options, {
        ...request,
        input: { cursor: pageOne.nextCursor, limit: 1, sourceRunId: request.runId },
      }),
    );
    expect(pageTwo.artifacts[0]).toMatchObject({ artifactId: oldest.data.id });
  });

  test("does not list another run's private artifact from the same deployment", async () => {
    const sourceRunId = id("14");
    const foreign = artifact(id("15"), 1);
    const privateArtifact = {
      ...foreign,
      data: { ...foreign.data, runId: sourceRunId, visibility: "private" as const },
    } as Artifact;
    const result = value(
      await sourceRunArtifacts(
        {
          artifactBucket: "artifacts",
          artifactS3: { send: async () => ({}) } as never,
          database: {
            getRecord: async () => undefined,
            queryRecords: async () => ({ items: [privateArtifact] }),
          } as unknown as DynamoDatabaseService,
          generateId: async () => id("19"),
        },
        { ...request, input: { sourceRunId } },
      ),
    );
    expect(result.artifacts).toEqual([]);
  });
});
