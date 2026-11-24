import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import {
  BrainExtractionLimitError,
  BrainIndexComponentError,
  BrainIndexRejectedBeforeWriteError,
  BrainIndexStaleError,
} from "./errors.ts";
import {
  BRAIN_EXTRACTION_LIMITS,
  chunkBrainText,
  extractBrainContent,
  deterministicBrainEntityKeys,
  indexBrainDocument,
  type BrainEmbeddingPort,
  type BrainIndexCanonicalSnapshot,
} from "./indexing.ts";
import type { BrainSearchProviderClient } from "./search-provider.ts";

const timestamp = "2026-07-30T12:00:00.000Z";
const bodyRef = {
  bucket: "content",
  byteSize: 12,
  contentType: "text/plain",
  key: "organizations/org-1/brains/brain-1/version-1/original",
  sha256: "sha256:content",
  versionId: "s3-version-1",
};

function snapshot(): BrainIndexCanonicalSnapshot {
  return {
    brain: {
      createdAt: timestamp,
      createdByPrincipalId: "principal-1",
      id: "brain-1",
      kind: "company",
      maintenancePolicy: {},
      name: "Engineering",
      organizationId: "org-1",
      ownershipGeneration: 0,
      retrievalPolicy: {},
      schemaVersion: 1,
      sensitivity: "internal",
      slug: "engineering",
      status: "active",
      updatedAt: timestamp,
      updatedByPrincipalId: "principal-1",
      version: 0,
    },
    document: {
      brainId: "brain-1",
      createdAt: timestamp,
      currentContentVersionId: "version-1",
      currentEnvelopeHash: "envelope",
      currentSourceOrder: 1,
      currentVersionId: "version-1",
      externalItemIdentity: "decision-1",
      id: "document-1",
      lifecycle: "active",
      organizationId: "org-1",
      projectionGeneration: 3,
      reviewStatus: "approved",
      sensitivity: "internal",
      sourceId: "source-1",
      title: "Decision",
      updatedAt: timestamp,
      version: 2,
    },
    rendition: {
      bodyRef,
      brainId: "brain-1",
      contentHash: "sha256:content",
      coordinateSystem: "utf8-byte",
      createdAt: timestamp,
      documentId: "document-1",
      documentVersionId: "version-1",
      id: "rendition-1",
      kind: "original",
      organizationId: "org-1",
    },
    source: {
      brainId: "brain-1",
      createdAt: timestamp,
      createdByPrincipalId: "principal-1",
      id: "source-1",
      kind: "upload",
      name: "Uploads",
      organizationId: "org-1",
      status: "active",
      updatedAt: timestamp,
      updatedByPrincipalId: "principal-1",
      version: 0,
    },
    version: {
      bodyRef,
      brainId: "brain-1",
      byteSize: 12,
      contentHash: "sha256:content",
      createdAt: timestamp,
      documentId: "document-1",
      envelopeHash: "envelope",
      id: "version-1",
      kind: "content",
      mediaType: "text/plain",
      organizationId: "org-1",
      originalRenditionId: "rendition-1",
      sourceId: "source-1",
      sourceOrder: 1,
    },
  };
}

const target = {
  location: {},
  providerId: "aws-native" as const,
  schemaGeneration: 1,
  targetId: "target-1",
};

function provider(overrides: Partial<BrainSearchProviderClient> = {}) {
  const deleted: string[][] = [];
  const value: BrainSearchProviderClient = {
    capabilities: {
      components: ["dense", "lexical", "exact", "entity"],
      hybrid: true,
    },
    deleteDocument: async (input) => {
      deleted.push([...input.chunkIds]);
      return { deleted: true };
    },
    inspect: async () => ({ components: [], ready: true }),
    prepare: async () => undefined,
    providerId: "aws-native",
    purgeBrain: async () => ({ deleted: true, receipt: {} }),
    purgeOrganization: async () => ({ deleted: true, receipt: {} }),
    search: async () => [],
    target,
    upsert: async (input) => ({
      components: ["dense", "lexical", "exact", "entity"].map((kind) => ({
        kind: kind as "dense" | "entity" | "exact" | "lexical",
        ready: true,
      })),
      written: input.chunks.length,
    }),
    ...overrides,
  };
  return { deleted, value };
}

function indexingFailure(input: {
  readonly bytes: Uint8Array;
  readonly embed?: BrainEmbeddingPort["embed"];
  readonly mediaType?: string;
  readonly provider?: BrainSearchProviderClient;
}) {
  const current = snapshot();
  const indexed = {
    ...current,
    version: { ...current.version, mediaType: input.mediaType ?? "text/plain" },
  };
  return indexBrainDocument({
    attemptId: "attempt-1",
    bytes: input.bytes,
    embeddings: { embed: input.embed ?? (async () => [0.1, 0.2]) },
    provider: input.provider ?? provider().value,
    revalidate: async () => indexed,
    snapshot: indexed,
    state: { publishReady: async () => true, recordIncomplete: async () => undefined },
    target,
  }).then(
    () => "indexed",
    (cause: unknown) => [
      cause instanceof Error ? cause.message : cause,
      cause instanceof BrainIndexRejectedBeforeWriteError,
    ],
  );
}

describe("Brain indexing", () => {
  afterEach(() => {
    setSystemTime();
  });

  test("extracts bounded UTF-8 and creates stable overlapping chunks", async () => {
    const extracted = await extractBrainContent({
      bytes: new TextEncoder().encode("first\r\nsecond"),
      mediaType: "text/plain",
    });
    expect(extracted.text).toBe("first\nsecond");
    expect(chunkBrainText("abcdefghij", { maxScalars: 6, overlapScalars: 2 })).toEqual([
      { end: 6, index: 0, start: 0, text: "abcdef" },
      { end: 10, index: 1, start: 4, text: "efghij" },
    ]);
    expect(
      deterministicBrainEntityKeys({
        text: "Alice Smith met Acme Corp. Alice Smith followed up.",
        title: "Customer Decision",
      }),
    ).toEqual(["acme corp", "alice smith", "customer decision"]);

    expect(
      extractBrainContent({
        bytes: new Uint8Array(BRAIN_EXTRACTION_LIMITS.maxRawBytes + 1),
        mediaType: "text/plain",
      }),
    ).rejects.toBeInstanceOf(BrainExtractionLimitError);
    expect(
      extractBrainContent({
        bytes: new Uint8Array(BRAIN_EXTRACTION_LIMITS.maxTokens * 3 + 1).fill(0x61),
        mediaType: "text/plain",
      }),
    ).rejects.toThrow("token limit");
  });

  test("rejects content every attempt would fail on before any provider write", async () => {
    const unwritten = provider({
      upsert: () => Promise.reject(new Error("The provider was written.")),
    }).value;
    const outcomes = await Promise.all(
      [
        { bytes: new Uint8Array([0x61, 0xff]), mediaType: "text/csv" },
        { bytes: new TextEncoder().encode("{"), mediaType: "application/json" },
        { bytes: new Uint8Array(750_001).fill(0x61), mediaType: "text/plain" },
        { bytes: new TextEncoder().encode("%PDF-1.7"), mediaType: "application/pdf" },
      ].map((input) => indexingFailure({ ...input, provider: unwritten })),
    );

    expect(outcomes).toEqual([
      ["Brain document text could not be extracted: text is not valid UTF-8.", true],
      ["Brain document text could not be extracted: text is not valid JSON.", true],
      ["Brain extraction exceeded token limit.", true],
      ["Brain document text could not be extracted: media type application/pdf is not text.", true],
    ]);
  });

  test("leaves the duration limit and failures after the provider write retryable", async () => {
    const outOfTime = await indexingFailure({
      bytes: new TextEncoder().encode("a".repeat(2_500)),
      embed: async () => {
        setSystemTime(new Date(Date.now() + BRAIN_EXTRACTION_LIMITS.maxDurationMs + 1));
        return [0.1, 0.2];
      },
    });
    setSystemTime();
    const afterWrite = await indexingFailure({
      bytes: new TextEncoder().encode("Evidence"),
      provider: provider({
        upsert: () => Promise.reject(new BrainExtractionLimitError("chunk count limit")),
      }).value,
    });

    expect([outOfTime, afterWrite]).toEqual([
      ["Brain extraction exceeded extraction and embedding duration.", false],
      ["Brain extraction exceeded chunk count limit.", false],
    ]);
  });

  test("indexes a PDF version from its normalized text rendition in UTF-8 bytes", async () => {
    const text = "--- Page 1 ---\nRevenue summary\f--- Page 2 ---\nNorth region grew 8%";
    const bytes = new TextEncoder().encode(text);
    const current = snapshot();
    const pdf: BrainIndexCanonicalSnapshot = {
      ...current,
      rendition: {
        ...current.rendition,
        bodyRef: {
          ...bodyRef,
          byteSize: bytes.byteLength,
          contentType: "text/plain; charset=utf-8",
          key: "organizations/org-1/brains/brain-1/document-versions/version-1/text/document-text-v1.txt",
          sha256: "sha256:text",
        },
        id: "rendition-normalized",
        kind: "normalized",
      },
      version: { ...current.version, mediaType: "application/pdf" },
    };
    const chunks: unknown[] = [];
    const search = provider({
      upsert: async (input) => {
        chunks.push(
          ...input.chunks.map(({ contentHash, coordinates, renditionId, text: chunkText }) => ({
            contentHash,
            coordinates,
            renditionId,
            text: chunkText,
          })),
        );
        return {
          components: (["dense", "lexical", "exact", "entity"] as const).map((kind) => ({
            kind,
            ready: true,
          })),
          written: input.chunks.length,
        };
      },
    });

    await indexBrainDocument({
      attemptId: "attempt-pdf",
      bytes,
      embeddings: { embed: async () => [0.1, 0.2] },
      provider: search.value,
      revalidate: async () => pdf,
      snapshot: pdf,
      state: { publishReady: async () => true, recordIncomplete: async () => undefined },
      target,
    });

    expect(chunks).toEqual([
      {
        contentHash: "sha256:content",
        coordinates: { end: bytes.byteLength, kind: "utf8-byte", start: 0 },
        renditionId: "rendition-normalized",
        text,
      },
    ]);
  });

  test("indexes a PDF text rendition whose font maps a glyph to NUL", async () => {
    const text = "--- Page 1 ---\nRevenue\u0000grew in the North region";
    const bytes = new TextEncoder().encode(text);
    const current = snapshot();
    const pdf: BrainIndexCanonicalSnapshot = {
      ...current,
      rendition: {
        ...current.rendition,
        bodyRef: {
          ...bodyRef,
          byteSize: bytes.byteLength,
          contentType: "text/plain; charset=utf-8",
          key: "organizations/org-1/brains/brain-1/document-versions/version-1/text/document-text-v1.txt",
          sha256: "sha256:text",
        },
        id: "rendition-normalized",
        kind: "normalized",
      },
      version: { ...current.version, mediaType: "application/pdf" },
    };
    const chunks: unknown[] = [];
    const search = provider({
      upsert: async (input) => {
        chunks.push(
          ...input.chunks.map(({ coordinates, text: chunkText }) => ({
            coordinates,
            text: chunkText,
          })),
        );
        return {
          components: (["dense", "lexical", "exact", "entity"] as const).map((kind) => ({
            kind,
            ready: true,
          })),
          written: input.chunks.length,
        };
      },
    });

    await indexBrainDocument({
      attemptId: "attempt-pdf-nul",
      bytes,
      embeddings: { embed: async () => [0.1, 0.2] },
      provider: search.value,
      revalidate: async () => pdf,
      snapshot: pdf,
      state: { publishReady: async () => true, recordIncomplete: async () => undefined },
      target,
    });

    expect(chunks).toEqual([
      {
        coordinates: { end: 47, kind: "utf8-byte", start: 0 },
        text: "--- Page 1 ---\nRevenue grew in the North region",
      },
    ]);
  });

  test("publishes only after all provider components and a current-version recheck", async () => {
    const search = provider();
    const publications: string[][] = [];
    const result = await indexBrainDocument({
      attemptId: "attempt-1",
      bytes: new TextEncoder().encode("The cited decision evidence."),
      embeddings: { embed: async () => [0.1, 0.2] },
      previousChunkIds: ["old-chunk"],
      provider: search.value,
      revalidate: async () => snapshot(),
      snapshot: snapshot(),
      state: {
        publishReady: async (publication) => {
          publications.push([...publication.chunkIds]);
          return true;
        },
        recordIncomplete: async () => undefined,
      },
      target,
    });

    expect(result.chunkCount).toBe(1);
    expect(publications[0]?.[0]).toContain("version-1:3:");
    expect(search.deleted).toEqual([["old-chunk"]]);
  });

  test("publishes UTF-8 byte coordinates against an original BOM-prefixed text rendition", async () => {
    const content = new TextEncoder().encode("é\r\nx");
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...content]);
    const current = snapshot();
    const original = {
      ...current,
      rendition: {
        ...current.rendition,
        bodyRef: { ...current.rendition.bodyRef, byteSize: bytes.byteLength },
      },
      version: {
        ...current.version,
        bodyRef: { ...current.version.bodyRef!, byteSize: bytes.byteLength },
        byteSize: bytes.byteLength,
      },
    };
    let coordinates:
      | { readonly end: number; readonly kind: string; readonly start: number }
      | undefined;
    const search = provider({
      upsert: async (input) => {
        coordinates = input.chunks[0]?.coordinates;
        return {
          components: ["dense", "lexical", "exact", "entity"].map((kind) => ({
            kind: kind as "dense" | "entity" | "exact" | "lexical",
            ready: true,
          })),
          written: input.chunks.length,
        };
      },
    });

    await indexBrainDocument({
      attemptId: "attempt-byte-coordinates",
      bytes,
      embeddings: { embed: async () => [0.1, 0.2] },
      provider: search.value,
      revalidate: async () => original,
      snapshot: original,
      state: {
        publishReady: async () => true,
        recordIncomplete: async () => undefined,
      },
      target,
    });

    expect(coordinates).toEqual({ end: bytes.byteLength, kind: "utf8-byte", start: 3 });
  });

  test("maps multibyte Unicode scalars and normalized newlines to original UTF-8 offsets", async () => {
    const content = new TextEncoder().encode("Aé😀\r\nZ");
    const extracted = await extractBrainContent({
      bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...content]),
      mediaType: "text/plain",
    });

    expect(extracted.text).toBe("Aé😀\nZ");
    expect(Array.from(extracted.utf8ByteBoundaries ?? [])).toEqual([3, 4, 6, 10, 12, 13]);
  });

  test("deletes newly written chunks when the canonical pointer changes", async () => {
    const search = provider();
    expect(
      indexBrainDocument({
        attemptId: "attempt-1",
        bytes: new TextEncoder().encode("Evidence"),
        embeddings: { embed: async () => [0.1, 0.2] },
        provider: search.value,
        revalidate: async () => ({
          ...snapshot(),
          document: { ...snapshot().document, currentVersionId: "version-2" },
        }),
        snapshot: snapshot(),
        state: {
          publishReady: async () => true,
          recordIncomplete: async () => undefined,
        },
        target,
      }),
    ).rejects.toBeInstanceOf(BrainIndexStaleError);
    expect(search.deleted[0]?.[0]).toContain("version-1:3:");
  });

  test("persists partial AWS-style completion without publishing ready state", async () => {
    let incomplete = false;
    const search = provider({
      upsert: async () => ({
        components: [
          { kind: "dense", ready: true },
          { kind: "lexical", ready: false },
          { kind: "exact", ready: false },
          { kind: "entity", ready: false },
        ],
        written: 0,
      }),
    });
    expect(
      indexBrainDocument({
        attemptId: "attempt-1",
        bytes: new TextEncoder().encode("Evidence"),
        embeddings: { embed: async () => [0.1, 0.2] },
        provider: search.value,
        revalidate: async () => snapshot(),
        snapshot: snapshot(),
        state: {
          publishReady: async () => true,
          recordIncomplete: async () => {
            incomplete = true;
          },
        },
        target,
      }),
    ).rejects.toBeInstanceOf(BrainIndexComponentError);
    expect(incomplete).toBe(true);
  });
});
