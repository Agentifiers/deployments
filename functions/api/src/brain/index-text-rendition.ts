import {
  BrainExtractionUnusableError,
  brainNormalizedRendition,
  brainNormalizedTextKey,
  brainTextRendition,
  type BrainBlobReference,
  type BrainDocumentRendition,
  type BrainIndexCanonicalSnapshot,
  type BrainRepository,
} from "@deployments-ai/brains";
import {
  createOrAdoptBrainDocumentRendition,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import type { ExtractionOutcome, FileTextExtractor } from "@deployments-ai/file-text";

export interface BrainTextRenditionStore {
  readonly presign: (reference: BrainBlobReference) => Promise<string>;
  readonly putOnce: (input: {
    readonly key: string;
    readonly sha256: string;
    readonly text: Uint8Array;
  }) => Promise<BrainBlobReference>;
}

const UNUSABLE_TEXT = {
  encrypted: "the file is password-protected",
  legacy_office_format: "the file is a legacy Office document, not a PDF or an HTML page",
  limits_exceeded: "the file exceeds the extraction limits for size, time, or memory",
  no_text: "the file has no text layer, and OCR found no text or is not turned on",
  unreadable: "the file is damaged, or its contents do not match its media type",
  unsupported_type: "the file is not a PDF or an HTML page",
} as const satisfies Record<Extract<ExtractionOutcome, { status: "unusable" }>["reason"], string>;

export async function ensureBrainTextRendition(input: {
  readonly database: DynamoDatabaseService;
  readonly extractor: FileTextExtractor;
  readonly now: string;
  readonly repository: BrainRepository;
  readonly signal?: AbortSignal;
  readonly snapshot: BrainIndexCanonicalSnapshot;
  readonly store: BrainTextRenditionStore;
}): Promise<BrainDocumentRendition> {
  const { rendition: original, version } = input.snapshot;
  const stored = await brainTextRendition(input.repository, version);
  if (stored) return stored;
  const outcome = await input.extractor.extract(
    {
      deadlineMs: 60_000,
      hint: version.mediaType ? { contentType: version.mediaType } : {},
      source: {
        byteSize: original.bodyRef.byteSize,
        sha256: original.bodyRef.sha256.replace(/^sha256:/u, ""),
        url: await input.store.presign(original.bodyRef),
      },
    },
    input.signal,
  );
  if (outcome.status === "unusable") {
    throw new BrainExtractionUnusableError(UNUSABLE_TEXT[outcome.reason]);
  }
  if (outcome.mediaType !== version.mediaType) {
    throw new BrainExtractionUnusableError(UNUSABLE_TEXT.unreadable);
  }
  const text = await input.store.putOnce({
    key: brainNormalizedTextKey(original),
    sha256: `sha256:${outcome.textSha256}`,
    text: outcome.text,
  });
  return createOrAdoptBrainDocumentRendition({
    database: input.database,
    rendition: brainNormalizedRendition({
      createdAt: input.now,
      extraction: { facts: outcome.facts, truncated: outcome.truncated },
      original,
      text,
    }),
  });
}
