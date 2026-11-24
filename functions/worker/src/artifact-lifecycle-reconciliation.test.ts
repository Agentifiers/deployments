import { describe, expect, test } from "bun:test";
import { RuntimeToolPreparationRetryableError } from "@deployments-ai/agent-runtime";
import {
  ArtifactRecord,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { replaceArtifact } from "./artifact-lifecycle-runtime-tools.ts";

const id = (suffix: string) => `01J000000000000000000000${suffix}` as Ulid;
const pins = { agentDefinitionId: id("01"), agentDeploymentId: id("02"), agentReleaseId: id("03") };
const previous = Schema.decodeUnknownSync(ArtifactRecord)(
  withCanonicalRecordKeys({
    data: {
      agentDeploymentId: id("02"),
      createdAt: "2026-07-29T00:00:00.000Z",
      environmentId: id("04"),
      id: id("10"),
      name: "report",
      organizationId: id("05"),
      privateAccess: "runtime-only",
      projectId: id("06"),
      runId: id("07"),
      status: "available",
      storage: {
        bucket: "artifacts",
        byteSize: 6,
        contentType: "text/plain",
        fileName: "report.txt",
        key: "report.txt",
        sha256: "0".repeat(64),
        versionId: "version-1",
      },
      type: "report",
      updatedAt: "2026-07-29T00:00:00.000Z",
      version: 0,
      visibility: "private",
    },
    itemType: "artifact",
  }),
);
const nextData = {
  ...previous.data,
  status: "deleted" as const,
  updatedAt: "2026-07-29T00:01:00.000Z",
  version: 1,
};

function database(options: { readonly commit: boolean; readonly reconciliationFails?: boolean }) {
  let current: PlatformRecord = previous;
  return {
    deleteRecord: async () => {},
    getRecord: async () => {
      if (options.reconciliationFails) throw new Error("read unavailable");
      return current;
    },
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      if (options.commit) {
        const put = operations.find((operation) => operation.kind === "put");
        if (put?.kind === "put") current = put.record;
      }
      throw new Error("transaction response lost");
    },
  } as unknown as DynamoDatabaseService;
}

const options = (db: DynamoDatabaseService) => ({
  artifactBucket: "artifacts",
  artifactS3: { send: async () => ({}) } as never,
  database: db,
  generateId: async () => id("19"),
});

describe("artifact lifecycle transaction reconciliation", () => {
  test("returns a mutation that committed before its response was lost", async () => {
    expect(
      replaceArtifact(
        options(database({ commit: true })),
        previous,
        nextData,
        "artifact.archived",
        {
          artifactId: previous.data.id,
        },
        pins,
      ),
    ).resolves.toMatchObject({ data: { status: "deleted", version: 1 } });
  });

  test("retries a transaction whose strong read confirms no commit", async () => {
    expect(
      replaceArtifact(
        options(database({ commit: false })),
        previous,
        nextData,
        "artifact.archived",
        { artifactId: previous.data.id },
        pins,
      ),
    ).rejects.toBeInstanceOf(RuntimeToolPreparationRetryableError);
  });

  test("keeps the outcome ambiguous when reconciliation itself fails", async () => {
    expect(
      replaceArtifact(
        options(database({ commit: false, reconciliationFails: true })),
        previous,
        nextData,
        "artifact.archived",
        { artifactId: previous.data.id },
        pins,
      ),
    ).rejects.toBeInstanceOf(AggregateError);
  });
});
