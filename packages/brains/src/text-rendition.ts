import {
  DOCUMENT_TEXT_EXTRACTOR,
  type DocumentMediaType,
} from "@deployments-ai/agent-manifest/input-files";
import { createHash } from "node:crypto";
import type { BrainBlobReference, BrainDocumentRendition, BrainDocumentVersion } from "./models.ts";
import type { BrainRepository } from "./ports.ts";

type BrainTextRenditionKind = Extract<BrainDocumentRendition["kind"], "normalized" | "original">;

const BRAIN_TEXT_RENDITION_KINDS = {
  "application/json": "original",
  "application/pdf": "normalized",
  "text/csv": "original",
  "text/html": "normalized",
  "text/markdown": "original",
  "text/plain": "original",
} as const satisfies Partial<Record<DocumentMediaType, BrainTextRenditionKind>>;

function isBrainTextMediaType(
  mediaType: string | undefined,
): mediaType is keyof typeof BRAIN_TEXT_RENDITION_KINDS {
  return mediaType !== undefined && Object.hasOwn(BRAIN_TEXT_RENDITION_KINDS, mediaType);
}

export function brainTextRenditionKind(
  mediaType: string | undefined,
): BrainTextRenditionKind | undefined {
  return isBrainTextMediaType(mediaType) ? BRAIN_TEXT_RENDITION_KINDS[mediaType] : undefined;
}

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function brainNormalizedRenditionId(documentVersionId: string) {
  let bits = BigInt(
    `0x${createHash("sha256")
      .update(
        `brain-rendition\u0000${documentVersionId}\u0000normalized\u0000${DOCUMENT_TEXT_EXTRACTOR}`,
      )
      .digest("hex")
      .slice(0, 32)}`,
  );
  let encoded = "";
  for (let index = 0; index < 26; index += 1) {
    encoded = CROCKFORD_BASE32.charAt(Number(bits & 31n)) + encoded;
    bits >>= 5n;
  }
  return encoded;
}

export function brainStoragePrefix(owner: {
  readonly brainId: string;
  readonly organizationId: string;
}) {
  return `organizations/${owner.organizationId}/brains/${owner.brainId}/`;
}

export function brainNormalizedTextKey(
  owner: Pick<BrainDocumentRendition, "brainId" | "documentVersionId" | "organizationId">,
) {
  return `${brainStoragePrefix(owner)}document-versions/${owner.documentVersionId}/text/${DOCUMENT_TEXT_EXTRACTOR}.txt`;
}

export async function brainTextRendition(
  repository: Pick<BrainRepository, "getDocumentRendition">,
  version: BrainDocumentVersion,
): Promise<BrainDocumentRendition | undefined> {
  switch (brainTextRenditionKind(version.mediaType)) {
    case "original":
      return version.originalRenditionId
        ? repository.getDocumentRendition(
            version.organizationId,
            version.id,
            version.originalRenditionId,
          )
        : undefined;
    case "normalized":
      return repository.getDocumentRendition(
        version.organizationId,
        version.id,
        brainNormalizedRenditionId(version.id),
      );
    case undefined:
      return undefined;
  }
}

export function brainNormalizedRendition(input: {
  readonly createdAt: string;
  readonly extraction: {
    readonly facts: Readonly<Record<string, unknown>>;
    readonly truncated: boolean;
  };
  readonly original: BrainDocumentRendition;
  readonly text: BrainBlobReference;
}): BrainDocumentRendition {
  const { original } = input;
  return {
    bodyRef: input.text,
    brainId: original.brainId,
    contentHash: original.contentHash,
    coordinateSystem: "utf8-byte",
    createdAt: input.createdAt,
    documentId: original.documentId,
    documentVersionId: original.documentVersionId,
    id: brainNormalizedRenditionId(original.documentVersionId),
    kind: "normalized",
    organizationId: original.organizationId,
    transformation: {
      extractor: DOCUMENT_TEXT_EXTRACTOR,
      facts: input.extraction.facts,
      sourceRenditionId: original.id,
      truncated: input.extraction.truncated,
    },
  };
}
