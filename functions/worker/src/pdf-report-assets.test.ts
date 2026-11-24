import { describe, expect, test } from "bun:test";
import { RuntimeToolPreparationRetryableError } from "@deployments-ai/agent-runtime";
import {
  dataBoundaryOf,
  OrganizationDataBoundary,
  type DynamoDatabaseService,
  type OrganizationDataBoundaryReader,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { resolvePdfAssets } from "./pdf-report-assets.ts";

const id = (suffix: string) => `01J000000000000000000000${suffix}` as Ulid;
const request = {
  agentDefinitionId: id("01"),
  agentDeploymentId: id("02"),
  agentReleaseId: id("03"),
  decision: { action: "allow" as const, reason: "test", toolCallId: id("09") },
  effect: "write" as const,
  environmentId: id("04"),
  idempotencyKey: "pdf-assets-test",
  inputSummary: "test",
  organizationId: id("05"),
  projectId: id("06"),
  requiredScopes: [],
  runId: id("07"),
  threadId: id("08"),
  toolName: "artifact.pdf_report",
};

const OPEN_BOUNDARY: OrganizationDataBoundaryReader = {
  read: async () => dataBoundaryOf(undefined),
};

describe("PDF report assets", () => {
  test("enforces the runtime asset-count bound before resolving content", async () => {
    expect(
      resolvePdfAssets(
        {
          artifactBucket: "artifacts",
          dataBoundaries: OPEN_BOUNDARY,
          artifactS3: { send: async () => ({}) } as never,
          database: {} as DynamoDatabaseService,
        },
        request,
        Array.from({ length: 51 }, (_, index) => ({ id: `asset-${index}` })),
      ),
    ).rejects.toThrow("more than 50 assets");
  });

  test("does not resolve unreferenced image content", async () => {
    const database = {
      deleteRecord: async () => {},
      getRecord: () => Promise.resolve(undefined),
      putRecord: async () => {},
      queryRecords: () => Promise.resolve({ items: [] }),
      transactWrite: async () => {},
    } as DynamoDatabaseService;
    const resolved = await resolvePdfAssets(
      {
        artifactBucket: "artifacts",
        dataBoundaries: OPEN_BOUNDARY,
        artifactS3: { send: async () => ({}) } as never,
        database,
      },
      request,
      [{ contentBase64: "not-base64", contentType: "image/png", id: "unused" }],
      new Set(),
    );
    expect(resolved.size).toBe(0);
  });

  test("rejects aggregate decoded image dimensions", async () => {
    const pngHeader = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pngHeader);
    pngHeader.write("IHDR", 12, "ascii");
    pngHeader.writeUInt32BE(4_096, 16);
    pngHeader.writeUInt32BE(4_096, 20);
    const database = {
      deleteRecord: async () => {},
      getRecord: () => Promise.resolve(undefined),
      putRecord: async () => {},
      queryRecords: () => Promise.resolve({ items: [] }),
      transactWrite: async () => {},
    } as DynamoDatabaseService;
    expect(
      resolvePdfAssets(
        {
          artifactBucket: "artifacts",
          dataBoundaries: OPEN_BOUNDARY,
          artifactS3: { send: async () => ({}) } as never,
          database,
        },
        request,
        ["first", "second"].map((assetId) => ({
          contentBase64: pngHeader.toString("base64"),
          contentType: "image/png",
          id: assetId,
        })),
      ),
    ).rejects.toThrow("aggregate pixel");
  });

  test("rejects oversized JPEG dimensions before rendering", async () => {
    const oversizedJpeg = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x20, 0x01, 0x00, 0x01, 0x03, 0x01, 0x11, 0x00,
      0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
    ]);
    const database = {
      deleteRecord: async () => {},
      getRecord: () => Promise.resolve(undefined),
      putRecord: async () => {},
      queryRecords: () => Promise.resolve({ items: [] }),
      transactWrite: async () => {},
    } as DynamoDatabaseService;

    expect(
      resolvePdfAssets(
        {
          artifactBucket: "artifacts",
          dataBoundaries: OPEN_BOUNDARY,
          artifactS3: { send: async () => ({}) } as never,
          database,
        },
        request,
        [
          {
            contentBase64: Buffer.from(oversizedJpeg).toString("base64"),
            contentType: "image/jpeg",
            id: "oversized-jpeg",
          },
        ],
      ),
    ).rejects.toThrow("JPEG dimensions");
  });

  test("rejects logically expired stored artifacts before loading S3 bytes", async () => {
    const artifact = {
      data: {
        environmentId: request.environmentId,
        id: id("10"),
        organizationId: request.organizationId,
        projectId: request.projectId,
        retentionExpiresAt: "2000-01-01T00:00:00.000Z",
        runId: request.runId,
        status: "available",
        storage: {
          bucket: "artifacts",
          byteSize: 100,
          contentType: "image/png",
          key: "expired.png",
          versionId: "version-1",
        },
        visibility: "private",
      },
      itemType: "artifact",
      pk: "test",
      sk: "test",
    } as unknown as PlatformRecord;
    const database = {
      deleteRecord: async () => {},
      getRecord: () => Promise.resolve(artifact),
      putRecord: async () => {},
      queryRecords: () => Promise.resolve({ items: [] }),
      transactWrite: async () => {},
    } as DynamoDatabaseService;
    let sends = 0;
    expect(
      resolvePdfAssets(
        {
          artifactBucket: "artifacts",
          dataBoundaries: OPEN_BOUNDARY,
          artifactS3: {
            send: async () => {
              sends += 1;
              return {};
            },
          } as never,
          database,
        },
        request,
        [{ artifactId: id("10"), id: "expired" }],
      ),
    ).rejects.toThrow("current scope");
    expect(sends).toBe(0);
  });

  test("classifies S3 image transport failures as retryable", async () => {
    const artifact = {
      data: {
        environmentId: request.environmentId,
        id: id("10"),
        organizationId: request.organizationId,
        projectId: request.projectId,
        runId: request.runId,
        status: "available",
        storage: {
          bucket: "artifacts",
          byteSize: 100,
          contentType: "image/png",
          key: "image.png",
          versionId: "version-1",
        },
        visibility: "private",
      },
      itemType: "artifact",
      pk: "test",
      sk: "test",
    } as unknown as PlatformRecord;
    const database = {
      deleteRecord: async () => {},
      getRecord: () => Promise.resolve(artifact),
      putRecord: async () => {},
      queryRecords: () => Promise.resolve({ items: [] }),
      transactWrite: async () => {},
    } as DynamoDatabaseService;
    expect(
      resolvePdfAssets(
        {
          artifactBucket: "artifacts",
          dataBoundaries: OPEN_BOUNDARY,
          artifactS3: { send: async () => Promise.reject(new Error("S3 unavailable")) } as never,
          database,
        },
        request,
        [{ artifactId: id("10"), id: "stored" }],
      ),
    ).rejects.toBeInstanceOf(RuntimeToolPreparationRetryableError);
  });

  test("accepts public version-pinned image artifacts from another run", async () => {
    const artifact = {
      data: {
        environmentId: request.environmentId,
        id: id("10"),
        organizationId: request.organizationId,
        projectId: request.projectId,
        runId: id("11"),
        status: "available",
        storage: {
          bucket: "artifacts",
          byteSize: 100,
          contentType: "image/png",
          key: "public.png",
          versionId: "version-1",
        },
        visibility: "public",
      },
      itemType: "artifact",
      pk: "test",
      sk: "test",
    } as unknown as PlatformRecord;
    const database = {
      deleteRecord: async () => {},
      getRecord: () => Promise.resolve(artifact),
      putRecord: async () => {},
      queryRecords: () => Promise.resolve({ items: [] }),
      transactWrite: async () => {},
    } as DynamoDatabaseService;
    let sends = 0;
    expect(
      resolvePdfAssets(
        {
          artifactBucket: "artifacts",
          dataBoundaries: OPEN_BOUNDARY,
          artifactS3: {
            send: async () => {
              sends += 1;
              throw new Error("S3 unavailable");
            },
          } as never,
          database,
        },
        request,
        [{ artifactId: id("10"), id: "public" }],
      ),
    ).rejects.toBeInstanceOf(RuntimeToolPreparationRetryableError);
    expect(sends).toBe(1);
  });

  test.each([
    ["transport", async () => Promise.reject(new Error("origin unavailable"))],
    ["HTTP 503", async () => ({ response: new Response(null, { status: 503 }) })],
  ])("classifies remote image %s failures as retryable", async (_case, remoteRequest) => {
    const database = {
      deleteRecord: async () => {},
      getRecord: () => Promise.resolve(undefined),
      putRecord: async () => {},
      queryRecords: () => Promise.resolve({ items: [] }),
      transactWrite: async () => {},
    } as DynamoDatabaseService;
    expect(
      resolvePdfAssets(
        {
          artifactBucket: "artifacts",
          dataBoundaries: OPEN_BOUNDARY,
          artifactS3: { send: async () => ({}) } as never,
          database,
          remoteRequest: remoteRequest as never,
        },
        request,
        [{ id: "remote", sourceUrl: "https://images.example/report.png" }],
      ),
    ).rejects.toBeInstanceOf(RuntimeToolPreparationRetryableError);
  });

  describe("in a phi data boundary", () => {
    const phi = dataBoundaryOf(
      Schema.decodeUnknownSync(OrganizationDataBoundary)({
        operatorNote: "BAA-2026-17",
        profile: "phi",
        setAt: "2026-11-01T00:00:00.000Z",
        setBy: { kind: "operator", principalId: id("11") },
      }),
    );
    const smallPng = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(smallPng);
    smallPng.write("IHDR", 12, "ascii");
    smallPng.writeUInt32BE(16, 16);
    smallPng.writeUInt32BE(16, 20);

    function phiOptions() {
      const reads: Ulid[] = [];
      let remoteRequests = 0;
      return {
        options: {
          artifactBucket: "artifacts",
          artifactS3: { send: async () => ({}) } as never,
          database: {} as DynamoDatabaseService,
          dataBoundaries: {
            read: async (organizationId: Ulid) => {
              reads.push(organizationId);
              return phi;
            },
          },
          remoteRequest: (async () => {
            remoteRequests += 1;
            return {
              response: new Response(smallPng, { headers: { "content-type": "image/png" } }),
            };
          }) as never,
        },
        reads,
        remoteRequests: () => remoteRequests,
      };
    }

    test("refuses a sourceUrl asset without fetching it", async () => {
      const { options, reads, remoteRequests } = phiOptions();

      const refusal = await resolvePdfAssets(options, request, [
        { id: "remote", sourceUrl: "https://images.example/report.png" },
      ]).then(
        () => undefined,
        (cause: unknown) => cause,
      );

      expect(refusal).toBeInstanceOf(TypeError);
      expect((refusal as Error).message).toBe(
        "PDF asset remote sourceUrl is outside this organization's phi data boundary; attach the image as an artifact instead.",
      );
      expect(reads).toEqual([request.organizationId]);
      expect(remoteRequests()).toBe(0);
    });

    test("resolves assets without a sourceUrl and never reads the boundary", async () => {
      const { options, reads } = phiOptions();

      const resolved = await resolvePdfAssets(options, request, [
        { contentBase64: smallPng.toString("base64"), contentType: "image/png", id: "inline" },
      ]);

      expect([...resolved.keys()]).toEqual(["inline"]);
      expect(reads).toEqual([]);
    });

    test("retries when the boundary cannot be read", async () => {
      const failure = new Error("standing read throttled");
      const refusal = await resolvePdfAssets(
        { ...phiOptions().options, dataBoundaries: { read: () => Promise.reject(failure) } },
        request,
        [{ id: "remote", sourceUrl: "https://images.example/report.png" }],
      ).catch((cause: unknown) => cause);
      expect(refusal).toBeInstanceOf(RuntimeToolPreparationRetryableError);
      expect((refusal as RuntimeToolPreparationRetryableError).preparationCause).toBe(failure);
    });
  });
});
