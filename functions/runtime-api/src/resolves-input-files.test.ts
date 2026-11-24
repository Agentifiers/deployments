import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  DEFAULT_TABLE_NAMES,
  Ulid,
  makeDynamoDatabase,
  withCanonicalRecordKeys,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { ExtractionUnavailableError, type ExtractionOutcome } from "@deployments-ai/file-text";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import {
  completeArtifactUpload,
  createArtifactUpload,
  getArtifact,
  listArtifacts,
} from "./artifact-operations.ts";
import {
  ARTIFACT_PENDING_ID as PENDING_ID,
  NOW,
  dependencies,
  makeDatabase,
  principal,
  scope,
} from "./artifact-operations.fixture.ts";
import type { RuntimeApiDependencies } from "./runtime-support.ts";

const ARTIFACT_PENDING_ID = Schema.decodeUnknownSync(Ulid)(PENDING_ID);
const MIB = 1024 * 1024;
const KMS_KEY = "arn:aws:kms:us-east-1:123456789012:key/artifacts";
const PDF = new TextEncoder().encode("%PDF-1.7 three pages");
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const UTF16_TEXT = Uint8Array.from([0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00, 0x62, 0x00]);
const TEXT = new TextEncoder().encode("--- Page 1 ---\nRevenue grew.\f--- Page 2 ---\nNorth led.");

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const textKey = (artifactKey: string) =>
  `${artifactKey.slice(0, artifactKey.lastIndexOf("/"))}/text/document-text-v1.txt`;

interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly versionId: string;
}

interface ObjectStore {
  readonly client: S3Client;
  readonly objects: Map<string, StoredObject>;
  readonly puts: string[];
  readonly ranges: string[];
}

interface Extraction {
  readonly fileTextExtractor: RuntimeApiDependencies["fileTextExtractor"];
  readonly requests: unknown[];
}

function objectStore(): ObjectStore {
  const objects = new Map<string, StoredObject>();
  const puts: string[] = [];
  const ranges: string[] = [];
  const client = new S3Client({
    credentials: { accessKeyId: "test-access-key", secretAccessKey: "test-secret-key" },
    region: "us-east-1",
  });
  client.send = (async (command: unknown) => {
    if (command instanceof HeadObjectCommand) {
      const object = objects.get(command.input.Key ?? "");
      if (!object) throw { $metadata: { httpStatusCode: 404 }, name: "NotFound" };
      return {
        ChecksumSHA256: createHash("sha256").update(object.body).digest("base64"),
        ContentLength: object.body.byteLength,
        ContentType: object.contentType,
        SSEKMSKeyId: KMS_KEY,
        ServerSideEncryption: "aws:kms",
        VersionId: object.versionId,
      };
    }
    if (command instanceof GetObjectCommand) {
      const object = objects.get(command.input.Key ?? "");
      if (!object || command.input.VersionId !== object.versionId) {
        throw { $metadata: { httpStatusCode: 404 }, name: "NoSuchKey" };
      }
      ranges.push(command.input.Range ?? "");
      const [, start = "0", end = String(object.body.byteLength - 1)] =
        /^bytes=(\d+)-(\d+)$/u.exec(command.input.Range ?? "") ?? [];
      const body = object.body.slice(Number(start), Number(end) + 1);
      return {
        Body: { transformToByteArray: async () => body },
        ContentLength: body.byteLength,
        VersionId: object.versionId,
      };
    }
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key ?? "";
      if (command.input.IfNoneMatch === "*" && objects.has(key)) {
        throw { $metadata: { httpStatusCode: 412 }, name: "PreconditionFailed" };
      }
      const body = command.input.Body;
      if (!(body instanceof Uint8Array)) throw new Error("Expected a byte body.");
      expect(command.input).toMatchObject({
        ChecksumSHA256: createHash("sha256").update(body).digest("base64"),
        ContentType: "text/plain; charset=utf-8",
        SSEKMSKeyId: KMS_KEY,
        ServerSideEncryption: "aws:kms",
      });
      puts.push(key);
      const versionId = `text-v${puts.length}`;
      objects.set(key, { body, contentType: "text/plain; charset=utf-8", versionId });
      return { VersionId: versionId };
    }
    throw new Error(`Unexpected S3 command ${String(command)}`);
  }) as S3Client["send"];
  return { client, objects, puts, ranges };
}

function extractor(outcome: () => Promise<ExtractionOutcome>): Extraction {
  const requests: unknown[] = [];
  return {
    requests,
    fileTextExtractor: {
      extract: async (request: unknown) => {
        requests.push(request);
        return outcome();
      },
    },
  };
}

async function uploadInput(
  api: RuntimeApiDependencies,
  s3: ObjectStore,
  file: {
    readonly bytes: Uint8Array;
    readonly contentType: string;
    readonly fileName?: string;
    readonly name: string;
  },
) {
  const fileName = file.fileName ?? file.name;
  const created = await createArtifactUpload(api, principal, {
    byteSize: file.bytes.byteLength,
    contentType: file.contentType,
    fileName,
    name: file.name,
    sha256: sha256(file.bytes),
    type: "input",
  });
  const key = [
    "artifacts/organizations",
    scope.organizationId,
    "projects",
    scope.projectId,
    "environments",
    scope.environmentId,
    "customer",
    created.artifact.artifactId,
    sha256(file.bytes),
    encodeURIComponent(fileName),
  ].join("/");
  s3.objects.set(key, { body: file.bytes, contentType: file.contentType, versionId: "source-v1" });
  return key;
}

function api(database: DynamoDatabaseService, s3: ObjectStore, extraction: Extraction) {
  return {
    ...dependencies(database),
    artifactS3: s3.client,
    fileTextExtractor: extraction.fileTextExtractor,
  } as RuntimeApiDependencies;
}

const artifactRecordKey = {
  pk: `ORG#${scope.organizationId}#ENV#${scope.environmentId}`,
  sk: `ARTIFACT#${ARTIFACT_PENDING_ID}`,
};

describe("run input file resolution at upload completion", () => {
  test("stores a document's text once and returns its resolution", async () => {
    const store = makeDatabase();
    const s3 = objectStore();
    const extraction = extractor(async () => ({
      facts: { kind: "pdf", pages: 3, pagesWithText: 2, ocrPages: 0 },
      mediaType: "application/pdf",
      status: "text",
      text: TEXT,
      textSha256: sha256(TEXT),
      truncated: false,
    }));
    const runtimeApi = api(store.database, s3, extraction);
    const key = await uploadInput(runtimeApi, s3, {
      bytes: PDF,
      contentType: "application/pdf",
      name: "q3 report.pdf",
    });

    const completed = await completeArtifactUpload(runtimeApi, principal, ARTIFACT_PENDING_ID);
    const replayed = await completeArtifactUpload(runtimeApi, principal, ARTIFACT_PENDING_ID);

    expect(completed).toMatchObject({
      input: {
        kind: "document",
        mediaType: "application/pdf",
        summary: "PDF, 3 pages (1 without text)",
      },
      status: "available",
    });
    expect(replayed).toEqual(completed);
    expect(s3.puts).toEqual([textKey(key)]);
    expect(s3.objects.get(textKey(key))?.body).toEqual(TEXT);
    expect(extraction.requests).toHaveLength(1);
    const [request] = extraction.requests as {
      readonly deadlineMs: number;
      readonly hint: unknown;
      readonly source: { readonly byteSize: number; readonly sha256: string; readonly url: string };
    }[];
    expect(request).toMatchObject({
      deadlineMs: 15_000,
      hint: { contentType: "application/pdf", fileName: "q3 report.pdf" },
      source: { byteSize: PDF.byteLength, sha256: sha256(PDF) },
    });
    const url = new URL(request!.source.url);
    expect(url.host).toBe("artifact-bucket.s3.us-east-1.amazonaws.com");
    expect(url.searchParams.get("versionId")).toBe("source-v1");
    expect(Number(url.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(120);
    const record = await store.database.getRecord("execution", artifactRecordKey);
    expect(record?.data).toMatchObject({
      input: {
        kind: "document",
        mediaType: "application/pdf",
        summary: "PDF, 3 pages (1 without text)",
        text: {
          byteSize: TEXT.byteLength,
          extractor: "document-text-v1",
          sha256: sha256(TEXT),
          truncated: false,
          versionId: "text-v1",
        },
      },
      status: "available",
    });
  });

  test("reuses text a crashed completion already stored", async () => {
    const store = makeDatabase();
    const s3 = objectStore();
    const extraction = extractor(async () => ({
      facts: { kind: "text", encoding: "utf-8", lines: 2 },
      mediaType: "text/csv",
      status: "text",
      text: TEXT,
      textSha256: sha256(TEXT),
      truncated: false,
    }));
    const runtimeApi = api(store.database, s3, extraction);
    const key = await uploadInput(runtimeApi, s3, {
      bytes: new TextEncoder().encode("a,b\n1,2\n"),
      contentType: "text/csv",
      name: "q3.csv",
    });
    s3.objects.set(textKey(key), {
      body: TEXT,
      contentType: "text/plain; charset=utf-8",
      versionId: "text-crashed",
    });

    const completed = await completeArtifactUpload(runtimeApi, principal, ARTIFACT_PENDING_ID);

    expect(s3.puts).toEqual([]);
    const record = await store.database.getRecord("execution", artifactRecordKey);
    expect(completed).toMatchObject({
      input: { kind: "document", mediaType: "text/csv", summary: "CSV file, 2 lines" },
    });
    expect(record?.data).toMatchObject({ input: { text: { versionId: "text-crashed" } } });
  });

  test("stores why an unreadable document can't be used", async () => {
    const store = makeDatabase();
    const s3 = objectStore();
    const extraction = extractor(async () => ({
      detail: "xref table is damaged",
      reason: "unreadable",
      status: "unusable",
    }));
    const runtimeApi = api(store.database, s3, extraction);
    await uploadInput(runtimeApi, s3, {
      bytes: PDF,
      contentType: "application/pdf",
      name: "broken.pdf",
    });

    const completed = await completeArtifactUpload(runtimeApi, principal, ARTIFACT_PENDING_ID);

    expect(completed).toMatchObject({
      input: {
        kind: "unusable",
        message: "the file is damaged, or its contents don't match its type.",
        reason: "unreadable",
      },
      status: "available",
    });
    expect(s3.puts).toEqual([]);
  });

  test("leaves the upload pending when extraction is unavailable", async () => {
    const store = makeDatabase();
    const s3 = objectStore();
    const extraction = extractor(async () => {
      throw new ExtractionUnavailableError("Document extraction could not be invoked.");
    });
    const runtimeApi = api(store.database, s3, extraction);
    await uploadInput(runtimeApi, s3, {
      bytes: PDF,
      contentType: "application/pdf",
      name: "q3.pdf",
    });

    const failure = await completeArtifactUpload(runtimeApi, principal, ARTIFACT_PENDING_ID).catch(
      (cause: unknown) => cause,
    );

    expect(failure).toMatchObject({ code: "input_file_resolution_unavailable", status: 503 });
    const record = await store.database.getRecord("execution", artifactRecordKey);
    expect(record?.data).toMatchObject({ status: "pending" });
    expect(record?.data).not.toHaveProperty("input");
  });

  test("types an image by its bytes without invoking extraction", async () => {
    const store = makeDatabase();
    const s3 = objectStore();
    const extraction = extractor(async () => {
      throw new Error("Images must not reach the extraction function.");
    });
    const runtimeApi = api(store.database, s3, extraction);
    await uploadInput(runtimeApi, s3, { bytes: PNG, contentType: "image/png", name: "photo.png" });

    const completed = await completeArtifactUpload(runtimeApi, principal, ARTIFACT_PENDING_ID);

    expect(completed).toMatchObject({
      input: { kind: "image", mediaType: "image/png" },
      status: "available",
    });
    expect(extraction.requests).toEqual([]);
    expect(s3.ranges).toEqual(["bytes=0-11"]);
  });

  test("sends text with a byte-order mark to extraction even when it looks like audio", async () => {
    const store = makeDatabase();
    const s3 = objectStore();
    const extraction = extractor(async () => ({
      facts: { kind: "text", encoding: "utf-16", lines: 1 },
      mediaType: "text/plain",
      status: "text",
      text: TEXT,
      textSha256: sha256(TEXT),
      truncated: true,
    }));
    const runtimeApi = api(store.database, s3, extraction);
    await uploadInput(runtimeApi, s3, {
      bytes: UTF16_TEXT,
      contentType: "application/octet-stream",
      name: "export",
    });

    const completed = await completeArtifactUpload(runtimeApi, principal, ARTIFACT_PENDING_ID);

    expect(completed).toMatchObject({
      input: { kind: "document", mediaType: "text/plain", summary: "text file, 1 line (UTF-16)" },
    });
    expect(extraction.requests).toHaveLength(1);
  });

  test("names the uploaded file, not the artifact's display name, in the extraction hint", async () => {
    const store = makeDatabase();
    const s3 = objectStore();
    const extraction = extractor(async () => ({
      facts: { kind: "text", encoding: "utf-8", lines: 2 },
      mediaType: "text/csv",
      status: "text",
      text: TEXT,
      textSha256: sha256(TEXT),
      truncated: false,
    }));
    const runtimeApi = api(store.database, s3, extraction);
    await uploadInput(runtimeApi, s3, {
      bytes: new TextEncoder().encode("a,b\n1,2\n"),
      contentType: "application/octet-stream",
      fileName: "q3.csv",
      name: "Q3 numbers",
    });

    await completeArtifactUpload(runtimeApi, principal, ARTIFACT_PENDING_ID);

    expect(extraction.requests).toMatchObject([
      { hint: { contentType: "application/octet-stream", fileName: "q3.csv" } },
    ]);
  });

  test("refuses run input uploads that are too large or not private", async () => {
    const store = makeDatabase();
    const s3 = objectStore();
    const runtimeApi = api(
      store.database,
      s3,
      extractor(async () => {
        throw new Error("Refused uploads never complete.");
      }),
    );
    const body = {
      contentType: "application/pdf",
      fileName: "big.pdf",
      name: "big.pdf",
      sha256: "a".repeat(64),
      type: "input",
    };

    expect(
      createArtifactUpload(runtimeApi, principal, { ...body, byteSize: 11 * MIB }),
    ).rejects.toMatchObject({ code: "input_file_too_large", status: 413 });
    expect(
      createArtifactUpload(runtimeApi, principal, {
        ...body,
        byteSize: MIB,
        visibility: "organization",
      }),
    ).rejects.toMatchObject({ code: "invalid_artifact_visibility", status: 400 });
    expect(
      createArtifactUpload(runtimeApi, principal, {
        ...body,
        byteSize: 11 * MIB,
        type: "report",
      }),
    ).resolves.toMatchObject({ artifact: { byteSize: 11 * MIB, type: "report" } });
  });

  test("serves, lists, and completes again an input upload that completed before resolution existed", async () => {
    const dynamo = fakeDynamoDocumentClient();
    const key = `artifacts/organizations/${scope.organizationId}/projects/${scope.projectId}/environments/${scope.environmentId}/customer/${PENDING_ID}/${sha256(PNG)}/photo.png`;
    dynamo.put(
      DEFAULT_TABLE_NAMES.execution,
      withCanonicalRecordKeys({
        data: {
          ...scope,
          createdAt: NOW,
          id: ARTIFACT_PENDING_ID,
          name: "photo.png",
          owner: { serviceAccountId: principal.serviceAccount.data.id, type: "service-account" },
          status: "available",
          storage: {
            bucket: "artifact-bucket",
            byteSize: PNG.byteLength,
            contentType: "image/png",
            fileName: "photo.png",
            key,
            sha256: sha256(PNG),
            versionId: "source-v1",
          },
          type: "input",
          updatedAt: NOW,
          version: 1,
          visibility: "private",
        },
        itemType: "artifact",
      }),
    );
    const runtimeApi = dependencies(makeDynamoDatabase(dynamo.client));
    const served = {
      artifactId: PENDING_ID,
      byteSize: PNG.byteLength,
      contentType: "image/png",
      createdAt: NOW,
      fileName: "photo.png",
      name: "photo.png",
      object: "artifact",
      status: "available",
      type: "input",
      updatedAt: NOW,
      version: 1,
      visibility: "private",
    };

    const fetched = await getArtifact(runtimeApi, principal, ARTIFACT_PENDING_ID);
    const listed = await listArtifacts(runtimeApi, principal, {});
    const completed = await completeArtifactUpload(runtimeApi, principal, ARTIFACT_PENDING_ID);

    expect(fetched).toMatchObject(served);
    expect(listed).toMatchObject({ artifacts: [served] });
    expect(completed).toMatchObject(served);
    expect(
      [fetched, ...listed.artifacts, completed].map((artifact) => "input" in artifact),
    ).toEqual([false, false, false]);
  });
});
