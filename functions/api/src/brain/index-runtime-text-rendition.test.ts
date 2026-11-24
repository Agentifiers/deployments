import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  makeBrainQueryRuntime,
  makeS3BrainRenditionHydrator,
  type Brain,
  type BrainBlobReference,
  type BrainDocument,
  type BrainDocumentRendition,
  type BrainDocumentVersion,
  type BrainIndexCanonicalSnapshot,
  type BrainIndexChunk,
  type BrainSearchProviderClient,
  type BrainSource,
} from "@deployments-ai/brains";
import {
  BrainIndexJobRecord,
  BrainSearchPlacementRecord,
  brainDocumentPlatformRecord,
  brainDocumentRenditionPlatformRecord,
  brainDocumentVersionPlatformRecord,
  brainPlatformRecord,
  brainSourcePlatformRecord,
  getBrainIndexJob,
  makeBrainDynamoRepository,
  makeDynamoDatabase,
  tableForItemType,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import {
  ExtractionUnavailableError,
  type ExtractionOutcome,
  type ExtractionRequest,
  type FileTextExtractor,
} from "@deployments-ai/file-text";
import { Schema } from "effect";
import { BRAIN_INDEX_LEASE_MS, processBrainIndexMessage } from "./index-runtime.ts";
import type { BrainTextRenditionStore } from "./index-text-rendition.ts";

const organizationId = "01ARZ3NDEKTSV4RRFFQ69G6006";
const brainId = "01M403FMNP7S2YVJ5Y67R3J87H";
const sourceId = "01M403FPPFMKRZF7PJ210Y070N";
const documentId = "01M403FR0Z4VNNQWM841K3XHP7";
const versionId = "01M403FPZ6T94GBCFS3W9HSAWC";
const originalId = "01M403FR0Z4VNNQWM841K3XHPA";
const targetId = "01M12QGESQ6N0M4ZT1H6M5CYZS";
const profileId = "01ARZ3NDEKTSV4RRFFQ69G6001";
const principalId = "01KYK5W3M7Z4KR6VP8BJTA8ACF";
const createdAt = "2026-10-03T05:23:44.287Z";
const now = new Date("2026-10-03T06:00:00.000Z");
const message = { documentId, idempotencyKey: `${documentId}:0:index`, organizationId };
const textKey = `organizations/${organizationId}/brains/${brainId}/document-versions/${versionId}/text/document-text-v1.txt`;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const pdf = new TextEncoder().encode("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF");
const text = "--- Page 1 ---\nRevenue summary\f--- Page 2 ---\nNorth region grew 8%";
const textBytes = new TextEncoder().encode(text);
const extracted: ExtractionOutcome = {
  facts: { kind: "pdf", pages: 2, pagesWithText: 2, ocrPages: 0 },
  mediaType: "application/pdf",
  status: "text",
  text: textBytes,
  textSha256: sha256(textBytes),
  truncated: false,
};

const target = {
  components: (["dense", "entity", "exact", "lexical"] as const).map((kind, index) => ({
    componentId: `01M12QGESQ6N0M4ZT1H6M5CYZ${"NPQR"[index]}`,
    kind,
  })),
  embeddingProfileId: profileId,
  location: { openSearchIndex: "brain-test" },
  providerId: "aws-native" as const,
  schemaGeneration: 1,
  targetId,
};

const brain: Brain = {
  createdAt,
  createdByPrincipalId: principalId,
  id: brainId,
  kind: "company",
  maintenancePolicy: {},
  name: "Finance Brain",
  organizationId,
  ownershipGeneration: 0,
  retrievalPolicy: {},
  schemaVersion: 1,
  sensitivity: "internal",
  slug: "finance-brain",
  status: "active",
  updatedAt: createdAt,
  updatedByPrincipalId: principalId,
  version: 1,
};

const source: BrainSource = {
  brainId,
  createdAt,
  createdByPrincipalId: principalId,
  id: sourceId,
  kind: "upload",
  name: "Uploads",
  organizationId,
  status: "active",
  updatedAt: createdAt,
  updatedByPrincipalId: principalId,
  version: 0,
};

const document: BrainDocument = {
  brainId,
  createdAt,
  currentContentVersionId: versionId,
  currentEnvelopeHash: "envelope",
  currentSourceOrder: 1,
  currentVersionId: versionId,
  externalItemIdentity: "quarterly-report",
  id: documentId,
  lifecycle: "active",
  organizationId,
  projectionGeneration: 0,
  reviewStatus: "approved",
  sensitivity: "internal",
  sourceId,
  title: "Quarterly report",
  updatedAt: createdAt,
  version: 1,
};

const pdfReference: BrainBlobReference = {
  bucket: "content",
  byteSize: pdf.byteLength,
  contentType: "application/pdf",
  key: `organizations/${organizationId}/brains/${brainId}/uploads/${versionId}`,
  sha256: `sha256:${sha256(pdf)}`,
  versionId: "pdf-version",
};

const version: BrainDocumentVersion = {
  bodyRef: pdfReference,
  brainId,
  byteSize: pdf.byteLength,
  contentHash: pdfReference.sha256,
  createdAt,
  documentId,
  envelopeHash: "envelope",
  id: versionId,
  kind: "content",
  mediaType: "application/pdf",
  organizationId,
  originalRenditionId: originalId,
  sourceId,
  sourceOrder: 1,
};

const original: BrainDocumentRendition = {
  bodyRef: pdfReference,
  brainId,
  contentHash: pdfReference.sha256,
  coordinateSystem: "utf8-byte",
  createdAt,
  documentId,
  documentVersionId: versionId,
  id: originalId,
  kind: "original",
  organizationId,
};

function fakeExtractor(...outcomes: readonly (Error | ExtractionOutcome)[]) {
  const requests: ExtractionRequest[] = [];
  return {
    extract: async (request: ExtractionRequest) => {
      requests.push(request);
      const outcome = outcomes[requests.length - 1] ?? outcomes.at(-1)!;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    requests,
  };
}

function objectStore() {
  const objects = new Map<string, { readonly bytes: Uint8Array; readonly versionId: string }>([
    [pdfReference.key, { bytes: pdf, versionId: pdfReference.versionId }],
  ]);
  const textRenditionStore: BrainTextRenditionStore = {
    presign: async (reference) =>
      `https://content.s3.test/${reference.key}?versionId=${reference.versionId}`,
    putOnce: async (input) => {
      if (objects.has(input.key)) throw new Error(`${input.key} already exists.`);
      objects.set(input.key, { bytes: input.text, versionId: "text-version" });
      return {
        bucket: "content",
        byteSize: input.text.byteLength,
        contentType: "text/plain; charset=utf-8",
        key: input.key,
        sha256: input.sha256,
        versionId: "text-version",
      };
    },
  };
  const read = (key: string, versionId: string) => {
    const object = objects.get(key);
    if (object?.versionId !== versionId) throw new Error(`No object ${key} at ${versionId}.`);
    return object.bytes;
  };
  return {
    hydrator: makeS3BrainRenditionHydrator({
      getObject: async ({ Key, Range, VersionId }) => {
        const [start, end] = (/^bytes=(\d+)-(\d+)$/u.exec(Range ?? "") ?? []).slice(1).map(Number);
        return {
          Body: {
            transformToByteArray: async () => read(Key, VersionId).subarray(start, end! + 1),
          },
        };
      },
    }),
    keys: () => [...objects.keys()].toSorted(),
    loadRendition: async (snapshot: BrainIndexCanonicalSnapshot) =>
      read(snapshot.rendition.bodyRef.key, snapshot.rendition.bodyRef.versionId),
    textRenditionStore,
  };
}

async function harness(input: {
  readonly extractor: FileTextExtractor;
  readonly upsertFailures?: number;
}) {
  const dynamo = fakeDynamoDocumentClient();
  const database = makeDynamoDatabase(dynamo.client);
  dynamo.put(
    "control",
    withCanonicalRecordKeys({
      data: {
        createdAt,
        id: organizationId,
        name: "Deployments.ai",
        slug: "deployments-ai",
        status: "active",
        updatedAt: createdAt,
        version: 1,
      },
      itemType: "organization" as const,
    }),
  );
  for (const record of [
    brainPlatformRecord(brain),
    brainSourcePlatformRecord(source),
    brainDocumentPlatformRecord(document),
    brainDocumentVersionPlatformRecord(version),
    brainDocumentRenditionPlatformRecord(original),
  ]) {
    dynamo.put(tableForItemType(record.itemType), record);
  }
  await database.transactWrite([
    {
      kind: "put",
      record: Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt,
            generation: 1,
            organizationId,
            phase: "active" as const,
            readTarget: target,
            updatedAt: createdAt,
            version: 1,
            writeTarget: target,
          },
          itemType: "brain-search-placement" as const,
        }),
      ),
    },
    {
      kind: "put",
      record: Schema.decodeUnknownSync(BrainIndexJobRecord)(
        withCanonicalRecordKeys({
          data: {
            attempt: 0,
            brainId,
            components: target.components.map((component) => ({
              ...component,
              status: "pending" as const,
            })),
            createdAt,
            documentId,
            documentVersionId: versionId,
            embeddingProfileId: profileId,
            expectedProjectionGeneration: 0,
            id: "01M403FR0Z4VNNQWM841K3XHP9",
            idempotencyKey: message.idempotencyKey,
            nextDueAt: createdAt,
            operation: "index" as const,
            organizationId,
            placementGeneration: 1,
            priority: 100,
            provider: "aws-native" as const,
            renditionId: originalId,
            schemaGeneration: 1,
            sourceId,
            status: "queued" as const,
            targetId,
            updatedAt: createdAt,
            version: 0,
          },
          itemType: "brain-index-job" as const,
        }),
      ),
    },
  ]);
  const chunks: BrainIndexChunk[] = [];
  let upsertFailures = input.upsertFailures ?? 0;
  const provider: BrainSearchProviderClient = {
    capabilities: { components: ["dense", "entity", "exact", "lexical"], hybrid: true },
    deleteDocument: async () => ({ deleted: true }),
    inspect: async () => ({ components: [], ready: true }),
    prepare: async () => undefined,
    providerId: "aws-native",
    purgeBrain: async () => ({ deleted: true, receipt: {} }),
    purgeOrganization: async () => ({ deleted: true, receipt: {} }),
    search: async () => chunks,
    target,
    upsert: async (request) => {
      if (upsertFailures > 0) {
        upsertFailures -= 1;
        throw new Error("Search provider is unavailable.");
      }
      chunks.splice(0, chunks.length, ...request.chunks);
      return {
        components: (["dense", "entity", "exact", "lexical"] as const).map((kind) => ({
          kind,
          ready: true,
        })),
        written: request.chunks.length,
      };
    },
  };
  const store = objectStore();
  const repository = makeBrainDynamoRepository(database);
  return {
    chunks,
    current: () => getBrainIndexJob(database, message),
    health: async () =>
      (await repository.listIndexHealth(organizationId, brainId, { limit: 10 })).items,
    queries: makeBrainQueryRuntime({
      answerModel: {
        synthesize: async ({ evidence }) => ({
          claims: [{ citationIds: [evidence[0]!.citationId], text: "North region grew 8%." }],
          gaps: [],
        }),
      },
      embeddings: { embedQuery: async () => [1, 0] },
      hydrator: store.hydrator,
      placement: { resolve: async () => ({ placementGeneration: 1, provider, target }) },
      repository,
      telemetry: { record: async () => ({ queryAttemptId: "query-1" }) },
    }),
    renditions: () =>
      dynamo
        .items(tableForItemType("brain-document-rendition"))
        .filter((item) => item.itemType === "brain-document-rendition")
        .map((item) => item.data as BrainDocumentRendition)
        .toSorted((left, right) => left.kind.localeCompare(right.kind)),
    run: (at = now) =>
      processBrainIndexMessage(message, {
        database,
        embeddings: () => ({ embed: async () => [1, 0] }),
        extractor: input.extractor,
        loadRendition: store.loadRendition,
        now: () => at,
        providers: { resolve: async () => provider },
        repository,
        textRenditionStore: store.textRenditionStore,
        workerId: "worker-1",
      }),
    store,
  };
}

describe("Brain PDF indexing", () => {
  test("indexes a PDF from one normalized text rendition that search and ask cite", async () => {
    const extractor = fakeExtractor(extracted);
    const value = await harness({ extractor });

    expect(await value.run()).toEqual({ chunkCount: 1, outcome: "indexed" });

    expect(extractor.requests).toEqual([
      {
        deadlineMs: 60_000,
        hint: { contentType: "application/pdf" },
        source: {
          byteSize: pdf.byteLength,
          sha256: sha256(pdf),
          url: `https://content.s3.test/${pdfReference.key}?versionId=pdf-version`,
        },
      },
    ]);
    const [normalized, stored] = value.renditions();
    expect(stored).toEqual(original);
    expect(normalized).toMatchObject({
      bodyRef: {
        bucket: "content",
        byteSize: textBytes.byteLength,
        contentType: "text/plain; charset=utf-8",
        key: textKey,
        sha256: `sha256:${sha256(textBytes)}`,
        versionId: "text-version",
      },
      brainId,
      contentHash: version.contentHash,
      coordinateSystem: "utf8-byte",
      createdAt: now.toISOString(),
      documentId,
      documentVersionId: versionId,
      kind: "normalized",
      organizationId,
      transformation: {
        extractor: "document-text-v1",
        facts: { kind: "pdf", pages: 2, pagesWithText: 2, ocrPages: 0 },
        sourceRenditionId: originalId,
        truncated: false,
      },
    });
    expect(normalized!.id).not.toBe(originalId);
    expect(
      value.chunks.map(({ contentHash, coordinates, renditionId, text: chunkText }) => ({
        contentHash,
        coordinates,
        renditionId,
        text: chunkText,
      })),
    ).toEqual([
      {
        contentHash: version.contentHash!,
        coordinates: { end: textBytes.byteLength, kind: "utf8-byte", start: 0 },
        renditionId: normalized!.id,
        text,
      },
    ]);
    expect((await value.health()).map((item) => [item.documentVersionId, item.status])).toEqual([
      [versionId, "ready"],
    ]);

    const query = {
      authorizeDisclosure: async () => brain,
      brainIds: [brainId],
      brains: [brain],
      organizationId,
    };
    const citation = {
      brainId,
      chunkId: value.chunks[0]!.chunkId,
      coordinates: { end: textBytes.byteLength, kind: "utf8-byte" as const, start: 0 },
      documentId,
      documentVersionId: versionId,
      renditionId: normalized!.id,
      sourceId,
    };
    expect(
      (await value.queries.search({ ...query, query: "North region" })).results.map((result) => ({
        citation: result.citation,
        excerpt: result.excerpt,
      })),
    ).toEqual([{ citation, excerpt: text }]);
    expect(
      await value.queries.ask({ ...query, question: "How did the North region do?" }),
    ).toMatchObject({
      claims: [{ text: "North region grew 8%." }],
      usedCitations: [citation],
    });
  });

  test("reuses the stored rendition when a failed attempt runs again", async () => {
    const extractor = fakeExtractor(extracted);
    const value = await harness({ extractor, upsertFailures: 1 });

    expect(value.run()).rejects.toThrow("Search provider is unavailable.");
    const failed = await value.current();
    expect(failed?.data).toMatchObject({ attempt: 1, status: "failed" });

    const retryAt = Math.max(
      Date.parse(failed!.data.nextDueAt!),
      now.getTime() + BRAIN_INDEX_LEASE_MS + 1,
    );
    expect(await value.run(new Date(retryAt))).toEqual({
      chunkCount: 1,
      outcome: "indexed",
    });
    expect(extractor.requests).toHaveLength(1);
    expect(value.store.keys()).toEqual([textKey, pdfReference.key]);
    expect(value.renditions().map((rendition) => rendition.kind)).toEqual([
      "normalized",
      "original",
    ]);
    expect(value.chunks.map((chunk) => chunk.renditionId)).toEqual([value.renditions()[0]!.id]);
  });

  test("fails a PDF without a text layer on its first attempt and shows it in index health", async () => {
    const value = await harness({
      extractor: fakeExtractor({ reason: "no_text", status: "unusable" }),
    });

    expect(value.run()).rejects.toThrow(
      "Brain document text could not be extracted: the file has no text layer, and OCR found no text or is not turned on.",
    );

    expect((await value.current())?.data).toMatchObject({
      attempt: 1,
      skipReason: "permanent-failure",
      status: "failed",
    });
    expect(await value.health()).toMatchObject([
      {
        documentVersionId: versionId,
        lastError:
          "Brain document text could not be extracted: the file has no text layer, and OCR found no text or is not turned on.",
        status: "failed",
      },
    ]);
    expect(value.renditions().map((rendition) => rendition.kind)).toEqual(["original"]);
    expect(value.store.keys()).toEqual([pdfReference.key]);
  });

  test("retries when the extraction function is unavailable", async () => {
    const value = await harness({
      extractor: fakeExtractor(new ExtractionUnavailableError("Document extraction failed.")),
    });

    expect(value.run()).rejects.toThrow("Document extraction failed.");

    const failed = await value.current();
    expect(failed?.data).toMatchObject({ attempt: 1, status: "failed" });
    expect(failed?.data).not.toHaveProperty("skipReason");
    expect(value.renditions().map((rendition) => rendition.kind)).toEqual(["original"]);
  });
});
