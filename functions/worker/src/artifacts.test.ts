import { describe, expect, test } from "bun:test";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  RuntimeArtifactPublicationError,
  RuntimeArtifactValidationError,
} from "@deployments-ai/agent-runtime";
import {
  tableForItemType,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import {
  createS3RuntimeArtifactLoader,
  createS3RuntimeArtifactPublicationRetrier,
  createS3RuntimeArtifactRecorder,
  runtimeArtifactId,
} from "./artifacts.ts";
import { ids, context } from "./artifacts.fixture.ts";

function memoryDatabase() {
  const records = new Map<string, PlatformRecord>();
  const operations: TransactionOperation[][] = [];
  const consistentReads: boolean[] = [];
  const itemKey = (table: string, pk: string, sk: string) => `${table}\u0000${pk}\u0000${sk}`;
  const database = {
    deleteRecord: async () => {},
    getRecord: async (
      table: string,
      key: { readonly pk: string; readonly sk: string },
      consistentRead?: boolean,
    ) => {
      consistentReads.push(consistentRead === true);
      return records.get(itemKey(table, key.pk, key.sk));
    },
    putRecord: async () => {},
    queryRecords: async () => ({ items: [] }),
    transactWrite: async (transaction: readonly TransactionOperation[]) => {
      operations.push([...transaction]);
      for (const operation of transaction) {
        if (operation.kind !== "put") continue;
        const record = operation.record;
        records.set(itemKey(tableForItemType(record.itemType), record.pk, record.sk), record);
      }
    },
  } as unknown as DynamoDatabaseService;
  return { consistentReads, database, operations, records };
}

describe("runtime artifact persistence", () => {
  test("derives stable IDs and persists one encrypted artifact across retries", async () => {
    const memory = memoryDatabase();
    const commands: unknown[] = [];
    const streamEvents: unknown[] = [];
    const recorder = createS3RuntimeArtifactRecorder({
      appendThreadEvent: async (event) => {
        streamEvents.push(event);
      },
      bucket: "artifact-bucket",
      client: {
        send: async (command: unknown) => {
          commands.push(command);
          return { ETag: '"etag"', VersionId: "version-1" };
        },
      } as never,
      database: memory.database,
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
      now: () => new Date("2026-07-23T12:00:00.000Z"),
    });
    const artifact = {
      content: "artifact body",
      contentType: "text/plain",
      fileName: "result.txt",
      label: "Provider result",
      metadata: { source: "test" },
      type: "report",
      visibility: "private",
    } as const;

    await recorder(artifact, 0, context);
    await recorder(artifact, 0, context);
    for (const mismatched of [
      { ...artifact, contentType: "application/json" },
      { ...artifact, label: "Different label" },
      { ...artifact, metadata: { source: "different" } },
      { ...artifact, type: "log" },
      { ...artifact, visibility: "organization" as const },
    ]) {
      expect(recorder(mismatched, 0, context)).rejects.toBeInstanceOf(
        RuntimeArtifactValidationError,
      );
    }

    for (const [recordKey, record] of memory.records) {
      if (record.itemType !== "artifact") continue;
      memory.records.set(recordKey, {
        ...record,
        data: { ...record.data, visibility: "organization" },
      });
    }
    await recorder(artifact, 0, context);

    expect(runtimeArtifactId(context.runId, 0)).toBe(runtimeArtifactId(context.runId, 0));
    expect(commands).toHaveLength(1);
    expect(memory.consistentReads).toEqual([true, true, true, true, true, true, true, true]);
    expect(memory.operations).toHaveLength(1);
    const stored = memory.operations[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "artifact",
    );
    expect(stored && stored.kind === "put" ? stored.record.data : undefined).toMatchObject({
      runId: context.runId,
      observability: {
        captureMode: "metadata-only",
        runSpanId: context.spanId,
        sessionId: context.threadId,
        traceId: context.traceId,
      },
      status: "available",
      storage: {
        bucket: "artifact-bucket",
        contentType: "text/plain",
        fileName: "result.txt",
        versionId: "version-1",
      },
      privateAccess: "runtime-only",
      visibility: "private",
    });
    expect(streamEvents).toHaveLength(1);
    expect(
      memory.operations[0]?.some(
        (operation) => operation.kind === "put" && operation.record.itemType === "semantic-event",
      ),
    ).toBe(false);
  });

  test("reconciles deterministic Brain-private artifact retries with their access owner", async () => {
    const memory = memoryDatabase();
    const commands: unknown[] = [];
    const recorder = createS3RuntimeArtifactRecorder({
      bucket: "artifact-bucket",
      client: {
        send: async (command: unknown) => {
          commands.push(command);
          return { ETag: '"etag"', VersionId: "version-1" };
        },
      } as never,
      database: memory.database,
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
      now: () => new Date("2026-07-23T12:00:00.000Z"),
    });
    const artifact = {
      content: "private Brain answer",
      contentType: "text/markdown",
      fileName: "brain-answer.md",
      label: "Private Brain answer",
      metadata: {
        brainIds: [ids[9]!],
        citations: [],
        initiatingServiceAccountId: ids[10]!,
        kind: "brain-private-publication",
      },
      type: "brain-private-publication",
      visibility: "private",
    } as const;

    await recorder(artifact, 32, context);
    expect(recorder(artifact, 32, context)).resolves.toBeUndefined();
    expect(commands).toHaveLength(1);
    expect(
      [...memory.records.values()].find((record) => record.itemType === "artifact"),
    ).toMatchObject({
      data: {
        owner: { serviceAccountId: ids[10], type: "service-account" },
        privateAccess: "brain-authorized",
      },
    });
  });

  test("bounds Unicode filenames by UTF-8 bytes before building the S3 key", async () => {
    const memory = memoryDatabase();
    let put: PutObjectCommand | undefined;
    const recorder = createS3RuntimeArtifactRecorder({
      bucket: "artifact-bucket",
      client: {
        send: async (command: unknown) => {
          if (command instanceof PutObjectCommand) put = command;
          return { VersionId: "version-1" };
        },
      } as never,
      database: memory.database,
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
    });

    await recorder(
      { content: "artifact body", fileName: `${"é".repeat(240)}.txt`, label: "Unicode" },
      0,
      context,
    );

    expect(new TextEncoder().encode(String(put?.input.Key)).byteLength).toBeLessThanOrEqual(1024);
    const stored = memory.operations[0]?.find(
      (operation) => operation.kind === "put" && operation.record.itemType === "artifact",
    );
    const artifactRecord =
      stored?.kind === "put" && stored.record.itemType === "artifact" ? stored.record : undefined;
    const fileName = artifactRecord?.data.storage.fileName;
    expect(new TextEncoder().encode(fileName ?? "").byteLength).toBeLessThanOrEqual(240);
  });

  test("classifies dot path artifact filenames as validation failures", async () => {
    const commands: unknown[] = [];
    const recorder = createS3RuntimeArtifactRecorder({
      bucket: "artifact-bucket",
      client: {
        send: async (command: unknown) => {
          commands.push(command);
          return { VersionId: "version-1" };
        },
      } as never,
      database: memoryDatabase().database,
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
    });

    expect(
      recorder({ content: "artifact body", fileName: "..", label: "Invalid" }, 0, context),
    ).rejects.toBeInstanceOf(RuntimeArtifactValidationError);
    expect(commands).toEqual([]);
  });

  test("marks committed stream publication failures as retryable", async () => {
    const memory = memoryDatabase();
    let failPublication = true;
    const commands: unknown[] = [];
    const recorder = createS3RuntimeArtifactRecorder({
      appendThreadEvent: async () => {
        if (failPublication) throw new Error("stream unavailable");
      },
      bucket: "artifact-bucket",
      client: {
        send: async (command: unknown) => {
          commands.push(command);
          return { VersionId: "version-1" };
        },
      } as never,
      database: memory.database,
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
    });
    const artifact = { content: "body", fileName: "result.txt", label: "Result" };

    let failure: unknown;
    try {
      await recorder(artifact, 0, context);
    } catch (cause) {
      failure = cause;
    }
    expect(failure).toBeInstanceOf(RuntimeArtifactPublicationError);
    expect((failure as RuntimeArtifactPublicationError).artifactPersisted).toBe(true);
    failPublication = false;
    expect(recorder(artifact, 0, context)).resolves.toBeUndefined();
    expect(commands).toHaveLength(1);
  });

  test("replays the canonical stream event from the persisted artifact record", async () => {
    const memory = memoryDatabase();
    const recorder = createS3RuntimeArtifactRecorder({
      bucket: "artifact-bucket",
      client: {
        send: async () => ({ VersionId: "version-1" }),
      } as never,
      database: memory.database,
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
      now: () => new Date("2026-07-23T12:00:00.000Z"),
    });
    await recorder(
      {
        content: "artifact body",
        contentType: "text/plain",
        fileName: "result.txt",
        label: "Provider result",
        type: "report",
      },
      3,
      context,
    );
    const events: unknown[] = [];
    const retryPublication = createS3RuntimeArtifactPublicationRetrier({
      appendThreadEvent: async (event) => void events.push(event),
      database: memory.database,
    });

    await retryPublication(3, context);

    expect(events).toEqual([
      expect.objectContaining({
        artifactId: runtimeArtifactId(context.runId, 3),
        eventId: runtimeArtifactId(context.runId, 3, "artifact-event"),
        eventType: "artifact.available",
        payload: expect.objectContaining({
          fileName: "result.txt",
          runId: context.runId,
          type: "report",
        }),
        runId: context.runId,
        threadId: context.threadId,
      }),
    ]);
  });

  test("does not publish private artifacts during stream retry", async () => {
    const memory = memoryDatabase();
    const recorder = createS3RuntimeArtifactRecorder({
      bucket: "artifact-bucket",
      client: { send: async () => ({ VersionId: "version-1" }) } as never,
      database: memory.database,
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
    });
    await recorder(
      { content: "secret", fileName: "private.txt", label: "Private", visibility: "private" },
      4,
      context,
    );
    let publications = 0;
    await createS3RuntimeArtifactPublicationRetrier({
      appendThreadEvent: async () => void (publications += 1),
      database: memory.database,
    })(4, context);
    expect(publications).toBe(0);
  });

  test("loads the exact persisted artifact body and canonical metadata", async () => {
    const memory = memoryDatabase();
    const body = new TextEncoder().encode("persisted artifact body");
    const recorder = createS3RuntimeArtifactRecorder({
      bucket: "artifact-bucket",
      client: {
        send: async () => ({ ETag: '"artifact-etag"', VersionId: "version-1" }),
      } as never,
      database: memory.database,
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
    });
    await recorder(
      {
        content: body,
        contentType: "text/plain",
        fileName: "result.txt",
        label: "Provider result",
        type: "report",
      },
      2,
      context,
    );
    let get: GetObjectCommand | undefined;
    const loader = createS3RuntimeArtifactLoader({
      bucket: "artifact-bucket",
      client: {
        send: async (command: unknown) => {
          if (command instanceof GetObjectCommand) get = command;
          return {
            Body: { transformToByteArray: async () => body },
            ContentLength: body.byteLength,
            ContentType: "text/plain",
            VersionId: "version-1",
          };
        },
      } as never,
      database: memory.database,
    });

    const loaded = await loader(2, context);

    expect(get?.input).toMatchObject({
      Bucket: "artifact-bucket",
      IfMatch: '"artifact-etag"',
      VersionId: "version-1",
    });
    expect(loaded).toMatchObject({
      contentType: "text/plain",
      fileName: "result.txt",
      label: "Provider result",
      type: "report",
    });
    expect(loaded.content).toEqual(body);
  });

  test("restores persisted text content and source metadata without changing representation", async () => {
    const memory = memoryDatabase();
    const content = "text with a control\u0000character";
    const body = new TextEncoder().encode(content);
    const recorder = createS3RuntimeArtifactRecorder({
      bucket: "artifact-bucket",
      client: {
        send: async () => ({ ETag: '"artifact-etag"', VersionId: "version-1" }),
      } as never,
      database: memory.database,
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
    });
    await recorder(
      {
        content,
        fileName: "result.txt",
        label: "Provider result",
        metadata: {
          artifactId: "source-artifact-id",
          continued: false,
          source: "provider.native_http",
        },
      },
      4,
      context,
    );
    const loader = createS3RuntimeArtifactLoader({
      bucket: "artifact-bucket",
      client: {
        send: async () => ({
          Body: { transformToByteArray: async () => body },
          ContentLength: body.byteLength,
          ContentType: "application/octet-stream",
          VersionId: "version-1",
        }),
      } as never,
      database: memory.database,
    });

    const loaded = await loader(4, context);

    expect(loaded.content).toBe(content);
    expect(loaded.metadata).toEqual({
      artifactId: "source-artifact-id",
      continued: false,
      source: "provider.native_http",
    });
  });

  test("rejects persisted artifacts without explicit content representation metadata", async () => {
    const memory = memoryDatabase();
    const body = new TextEncoder().encode("legacy artifact body");
    const recorder = createS3RuntimeArtifactRecorder({
      bucket: "artifact-bucket",
      client: {
        send: async () => ({ ETag: '"artifact-etag"', VersionId: "version-1" }),
      } as never,
      database: memory.database,
      kmsKeyId: "arn:aws:kms:us-east-1:123456789012:key/00000000-0000-0000-0000-000000000000",
    });
    await recorder({ content: body, fileName: "legacy.txt", label: "Legacy artifact" }, 5, context);
    const [storedKey, stored] = [...memory.records.entries()][0]!;
    if (stored.itemType !== "artifact") throw new Error("Expected an artifact record.");
    const { contentEncoding: _contentEncoding, ...metadata } = stored.data.metadata ?? {};
    memory.records.set(storedKey, {
      ...stored,
      data: { ...stored.data, metadata },
    });
    const loader = createS3RuntimeArtifactLoader({
      bucket: "artifact-bucket",
      client: {
        send: async () => ({
          Body: { transformToByteArray: async () => body },
          ContentLength: body.byteLength,
          ContentType: "application/octet-stream",
          VersionId: "version-1",
        }),
      } as never,
      database: memory.database,
    });

    expect(loader(5, context)).rejects.toThrow("content encoding is missing or invalid");
  });
});
