import { MAX_DOCUMENT_SOURCE_BYTES } from "@deployments-ai/agent-manifest/input-files";
import {
  BrainExtractionDurationError,
  BrainExtractionLimitError,
  BrainExtractionUnusableError,
  BrainIndexComponentError,
  BrainIndexStaleError,
  rethrowRejectedBeforeWrite,
} from "./errors.ts";
import type {
  Brain,
  BrainDocument,
  BrainDocumentRendition,
  BrainDocumentVersion,
  BrainSource,
} from "./models.ts";
import type {
  BrainIndexChunk,
  BrainSearchComponentResult,
  BrainSearchProviderClient,
  BrainSearchTarget,
} from "./search-provider.ts";
import { brainTextRenditionKind } from "./text-rendition.ts";

export const BRAIN_EXTRACTION_LIMITS = {
  maxChunks: 512,
  maxDurationMs: 60_000,
  maxNormalizedBytes: 8 * 1_024 * 1_024,
  maxPagesOrSegments: 500,
  maxRawBytes: MAX_DOCUMENT_SOURCE_BYTES,
  maxTokens: 250_000,
} as const;

export interface BrainExtractionResult {
  readonly estimatedTokens: number;
  readonly pagesOrSegments: number;
  readonly text: string;
  readonly utf8ByteBoundaries: Uint32Array;
}

export interface BrainEmbeddingPort {
  readonly embed: (input: {
    readonly modelCallId: string;
    readonly signal?: AbortSignal;
    readonly text: string;
  }) => Promise<readonly number[]>;
}

export interface BrainIndexCanonicalSnapshot {
  readonly brain: Brain;
  readonly document: BrainDocument;
  readonly rendition: BrainDocumentRendition;
  readonly source: BrainSource;
  readonly version: BrainDocumentVersion;
}

export interface BrainIndexPublication {
  readonly attemptId: string;
  readonly chunkIds: readonly string[];
  readonly components: readonly BrainSearchComponentResult[];
  readonly contentHash: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly projectionGeneration: number;
  readonly target: BrainSearchTarget;
}

export interface BrainIndexStatePort {
  readonly publishReady: (publication: BrainIndexPublication) => Promise<boolean>;
  readonly recordIncomplete: (publication: BrainIndexPublication) => Promise<void>;
}

export const MAX_BRAIN_GRAPH_PROJECTION_CANDIDATES = 15;

export interface BrainGraphProjectionPort {
  readonly publishProjection: (input: {
    readonly attemptId: string;
    readonly candidates: readonly {
      readonly canonicalName: string;
      readonly kind: "company" | "concept" | "person" | "project";
      readonly normalizedAliases: readonly string[];
    }[];
    readonly snapshot: BrainIndexCanonicalSnapshot;
  }) => Promise<{
    readonly edgeIds: readonly string[];
    readonly entityIds: readonly string[];
    readonly reviewItemIds: readonly string[];
  }>;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Brain indexing aborted.");
}

function utf8Width(codePoint: number) {
  return codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
}

function normalizeUtf8Text(text: string, initialRawByteOffset = 0) {
  const maximumScalars = BRAIN_EXTRACTION_LIMITS.maxTokens * 3;
  const utf8ByteBoundaries = new Uint32Array(Math.min(text.length, maximumScalars) + 1);
  utf8ByteBoundaries[0] = initialRawByteOffset;
  let normalizedBytes = 0;
  let rawByteOffset = initialRawByteOffset;
  let scalarCount = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index)!;
    const utf16Width = codePoint > 0xffff ? 2 : 1;
    if (codePoint === 0x0d) {
      rawByteOffset += 1;
      index += 1;
      if (text.charCodeAt(index) === 0x0a) {
        rawByteOffset += 1;
        index += 1;
      }
      normalizedBytes += 1;
    } else {
      const byteWidth = utf8Width(codePoint);
      rawByteOffset += byteWidth;
      normalizedBytes += byteWidth;
      index += utf16Width;
    }
    if (normalizedBytes > BRAIN_EXTRACTION_LIMITS.maxNormalizedBytes) {
      throw new BrainExtractionLimitError("normalized byte limit");
    }
    scalarCount += 1;
    if (scalarCount > maximumScalars) throw new BrainExtractionLimitError("token limit");
    utf8ByteBoundaries[scalarCount] = rawByteOffset;
  }
  return {
    text: text.replaceAll("\r\n", "\n").replaceAll("\r", "\n"),
    utf8ByteBoundaries: utf8ByteBoundaries.slice(0, scalarCount + 1),
  };
}

export async function extractBrainContent(input: {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly signal?: AbortSignal;
}): Promise<BrainExtractionResult> {
  throwIfAborted(input.signal);
  if (input.bytes.byteLength > BRAIN_EXTRACTION_LIMITS.maxRawBytes) {
    throw new BrainExtractionLimitError("raw byte limit");
  }
  if (brainTextRenditionKind(input.mediaType) !== "original") {
    throw new BrainExtractionUnusableError(`media type ${input.mediaType} is not text`);
  }
  let text: string;
  try {
    // PDF fonts can map glyphs to U+0000. A space has the same one-byte UTF-8 width, so citation
    // offsets into the stored rendition stay exact.
    text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes).replaceAll("\u0000", " ");
  } catch {
    throw new BrainExtractionUnusableError("text is not valid UTF-8");
  }
  if (input.mediaType === "application/json") {
    try {
      JSON.parse(text);
    } catch {
      throw new BrainExtractionUnusableError("text is not valid JSON");
    }
  }
  const utf8BomBytes =
    input.bytes[0] === 0xef && input.bytes[1] === 0xbb && input.bytes[2] === 0xbf ? 3 : 0;
  const normalized = normalizeUtf8Text(text, utf8BomBytes);
  const pagesOrSegments = text.split("\f").length;
  if (pagesOrSegments > BRAIN_EXTRACTION_LIMITS.maxPagesOrSegments) {
    throw new BrainExtractionLimitError("page or segment limit");
  }
  return {
    estimatedTokens: Math.ceil((normalized.utf8ByteBoundaries.length - 1) / 3),
    pagesOrSegments,
    text: normalized.text,
    utf8ByteBoundaries: normalized.utf8ByteBoundaries,
  };
}

interface TextChunk {
  readonly end: number;
  readonly index: number;
  readonly start: number;
  readonly text: string;
}

export function deterministicBrainEntityKeys(input: {
  readonly text: string;
  readonly title?: string;
}) {
  const values = new Set<string>();
  const add = (value: string) => {
    const normalized = value
      .normalize("NFKC")
      .toLowerCase()
      .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
      .trim();
    if (normalized.length >= 2 && normalized.length <= 200) values.add(normalized);
  };
  if (input.title) add(input.title);
  for (const match of input.text.matchAll(
    /\b\p{Lu}[\p{L}\p{N}&-]*(?:\s+\p{Lu}[\p{L}\p{N}&-]*){0,4}\b/gu,
  )) {
    add(match[0]);
    if (values.size === 50) break;
  }
  return [...values].sort();
}

export function chunkBrainText(
  text: string,
  options: { readonly maxScalars?: number; readonly overlapScalars?: number } = {},
): readonly TextChunk[] {
  const maxScalars = options.maxScalars ?? 2_000;
  const overlapScalars = options.overlapScalars ?? 200;
  if (
    !Number.isSafeInteger(maxScalars) ||
    !Number.isSafeInteger(overlapScalars) ||
    maxScalars < 1 ||
    overlapScalars < 0 ||
    overlapScalars >= maxScalars
  ) {
    throw new TypeError("Brain chunk limits are invalid.");
  }
  const scalars = Array.from(text);
  const chunks: TextChunk[] = [];
  let start = 0;
  while (start < scalars.length) {
    let end = Math.min(scalars.length, start + maxScalars);
    if (end < scalars.length) {
      const minimumBreak = start + Math.floor(maxScalars * 0.75);
      for (let cursor = end; cursor > minimumBreak; cursor -= 1) {
        if (scalars[cursor - 1] === "\n") {
          end = cursor;
          break;
        }
      }
    }
    const chunkText = scalars.slice(start, end).join("").trim();
    if (chunkText) chunks.push({ end, index: chunks.length, start, text: chunkText });
    if (end === scalars.length) break;
    start = end - overlapScalars;
    if (chunks.length >= BRAIN_EXTRACTION_LIMITS.maxChunks) {
      throw new BrainExtractionLimitError("chunk count limit");
    }
  }
  return chunks;
}

function validateSnapshot(snapshot: BrainIndexCanonicalSnapshot) {
  const { brain, document, rendition, source, version } = snapshot;
  if (
    brain.status !== "active" ||
    source.status !== "active" ||
    document.lifecycle !== "active" ||
    document.reviewStatus === "rejected" ||
    version.kind !== "content" ||
    document.currentContentVersionId !== version.id ||
    brain.organizationId !== document.organizationId ||
    source.organizationId !== document.organizationId ||
    version.organizationId !== document.organizationId ||
    rendition.organizationId !== document.organizationId ||
    source.brainId !== brain.id ||
    document.brainId !== brain.id ||
    version.brainId !== brain.id ||
    rendition.brainId !== brain.id ||
    document.sourceId !== source.id ||
    version.sourceId !== source.id ||
    version.documentId !== document.id ||
    rendition.documentId !== document.id ||
    rendition.documentVersionId !== version.id ||
    rendition.contentHash !== version.contentHash
  ) {
    throw new BrainIndexStaleError();
  }
}

function sameCurrentSnapshot(
  before: BrainIndexCanonicalSnapshot,
  after: BrainIndexCanonicalSnapshot,
) {
  return (
    before.brain.version === after.brain.version &&
    before.source.version === after.source.version &&
    before.document.version === after.document.version &&
    before.document.projectionGeneration === after.document.projectionGeneration &&
    before.document.currentVersionId === after.document.currentVersionId &&
    before.document.currentContentVersionId === after.document.currentContentVersionId &&
    before.version.id === after.version.id &&
    before.rendition.id === after.rendition.id
  );
}

export async function indexBrainDocument(input: {
  readonly attemptId: string;
  readonly bytes: Uint8Array;
  readonly embeddings: BrainEmbeddingPort;
  readonly graph?: BrainGraphProjectionPort;
  readonly previousChunkIds?: readonly string[];
  readonly provider: BrainSearchProviderClient;
  readonly revalidate: () => Promise<BrainIndexCanonicalSnapshot>;
  readonly signal?: AbortSignal;
  readonly snapshot: BrainIndexCanonicalSnapshot;
  readonly state: BrainIndexStatePort;
  readonly target: BrainSearchTarget;
}) {
  const startedAt = Date.now();
  validateSnapshot(input.snapshot);
  if (
    input.provider.target.targetId !== input.target.targetId ||
    input.provider.target.schemaGeneration !== input.target.schemaGeneration ||
    input.provider.providerId !== input.target.providerId
  ) {
    throw new TypeError("Brain indexing provider is not bound to the selected target.");
  }
  const requiredComponents = ["dense", "lexical", "exact", "entity"] as const;
  if (
    !input.provider.capabilities.hybrid ||
    requiredComponents.some((kind) => !input.provider.capabilities.components.includes(kind))
  ) {
    throw new BrainIndexComponentError(requiredComponents);
  }
  const version = input.snapshot.version;
  const extracted = await extractBrainContent({
    bytes: input.bytes,
    mediaType: input.snapshot.rendition.kind === "normalized" ? "text/plain" : version.mediaType!,
    ...(input.signal ? { signal: input.signal } : {}),
  })
    .then((content) => ({ ...content, textChunks: chunkBrainText(content.text) }))
    .catch(rethrowRejectedBeforeWrite);
  const entityKeys = deterministicBrainEntityKeys({
    text: extracted.text,
    ...(input.snapshot.document.title ? { title: input.snapshot.document.title } : {}),
  });
  const entityCandidates = entityKeys
    .slice(0, MAX_BRAIN_GRAPH_PROJECTION_CANDIDATES)
    .map((alias) => ({
      canonicalName: alias,
      kind: "concept" as const,
      normalizedAliases: [alias],
    }));
  const chunks: BrainIndexChunk[] = [];
  for (const chunk of extracted.textChunks) {
    throwIfAborted(input.signal);
    if (Date.now() - startedAt > BRAIN_EXTRACTION_LIMITS.maxDurationMs) {
      throw new BrainExtractionDurationError();
    }
    const chunkId = `${version.id}:${input.snapshot.document.projectionGeneration}:${chunk.index.toString(36)}:${chunk.start}-${chunk.end}`;
    const embedding = await input.embeddings.embed({
      modelCallId: `${input.attemptId}:${chunk.index}`,
      ...(input.signal ? { signal: input.signal } : {}),
      text: chunk.text,
    });
    const coordinates =
      input.snapshot.rendition.coordinateSystem === "unicode-scalar"
        ? { end: chunk.end, kind: "unicode-scalar" as const, start: chunk.start }
        : input.snapshot.rendition.coordinateSystem === "utf8-byte"
          ? {
              end: extracted.utf8ByteBoundaries[chunk.end]!,
              kind: "utf8-byte" as const,
              start: extracted.utf8ByteBoundaries[chunk.start]!,
            }
          : undefined;
    if (!coordinates) {
      throw new TypeError(
        `Brain rendition coordinate system ${input.snapshot.rendition.coordinateSystem} is unavailable for the extracted content.`,
      );
    }
    chunks.push({
      brainId: input.snapshot.brain.id,
      chunkId,
      contentHash: version.contentHash!,
      coordinates,
      documentId: input.snapshot.document.id,
      documentVersionId: version.id,
      embedding,
      entityKeys,
      organizationId: input.snapshot.document.organizationId,
      projectionGeneration: input.snapshot.document.projectionGeneration,
      renditionId: input.snapshot.rendition.id,
      retentionExpiresAtMs: 8_640_000_000_000_000,
      reviewStatus: input.snapshot.document.reviewStatus,
      schemaGeneration: input.target.schemaGeneration,
      sensitivity: input.snapshot.document.sensitivity,
      sourceId: input.snapshot.source.id,
      text: chunk.text,
      ...(input.snapshot.document.title ? { title: input.snapshot.document.title } : {}),
    });
  }
  if (input.graph) {
    await input.graph.publishProjection({
      attemptId: input.attemptId,
      candidates: entityCandidates,
      snapshot: input.snapshot,
    });
  }
  const mutation = await input.provider.upsert({
    chunks,
    organizationId: input.snapshot.document.organizationId,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const publication: BrainIndexPublication = {
    attemptId: input.attemptId,
    chunkIds: chunks.map((chunk) => chunk.chunkId),
    components: mutation.components,
    contentHash: version.contentHash!,
    documentId: input.snapshot.document.id,
    documentVersionId: version.id,
    projectionGeneration: input.snapshot.document.projectionGeneration,
    target: input.target,
  };
  const incomplete = requiredComponents.filter(
    (kind) => !mutation.components.some((component) => component.kind === kind && component.ready),
  );
  if (incomplete.length > 0) {
    await input.state.recordIncomplete(publication);
    throw new BrainIndexComponentError(incomplete);
  }
  const current = await input.revalidate();
  try {
    validateSnapshot(current);
  } catch {
    await input.provider.deleteDocument({
      brainId: input.snapshot.brain.id,
      chunkIds: publication.chunkIds,
      documentId: input.snapshot.document.id,
      organizationId: input.snapshot.document.organizationId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    throw new BrainIndexStaleError();
  }
  if (
    !sameCurrentSnapshot(input.snapshot, current) ||
    !(await input.state.publishReady(publication))
  ) {
    await input.provider.deleteDocument({
      brainId: input.snapshot.brain.id,
      chunkIds: publication.chunkIds,
      documentId: input.snapshot.document.id,
      organizationId: input.snapshot.document.organizationId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    throw new BrainIndexStaleError();
  }
  const previousChunkIds = (input.previousChunkIds ?? []).filter(
    (chunkId) => !publication.chunkIds.includes(chunkId),
  );
  if (previousChunkIds.length > 0) {
    await input.provider.deleteDocument({
      brainId: input.snapshot.brain.id,
      chunkIds: previousChunkIds,
      documentId: input.snapshot.document.id,
      organizationId: input.snapshot.document.organizationId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  }
  return {
    chunkCount: chunks.length,
    estimatedTokens: extracted.estimatedTokens,
    publication,
  };
}
