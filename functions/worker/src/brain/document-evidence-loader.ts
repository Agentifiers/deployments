import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { brainTextRendition, type BrainRepository } from "@deployments-ai/brains";
import { createHash } from "node:crypto";
import type { BrainDocumentEvidence } from "./runtime.ts";
import { artifactBucketAllowed } from "../artifact-buckets.ts";

export function createBrainDocumentEvidenceLoader(input: {
  readonly bucket: string;
  readonly legacyBuckets?: readonly string[];
  readonly repository: BrainRepository;
  readonly s3: Pick<S3Client, "send">;
}) {
  return async (request: {
    readonly brain: Awaited<ReturnType<BrainRepository["get"]>> & {};
    readonly documentId: string;
    readonly maxBytes: number;
    readonly startByte: number;
  }): Promise<BrainDocumentEvidence> => {
    const { brain, documentId, maxBytes, startByte } = request;
    const document = await input.repository.getDocument(brain.organizationId, brain.id, documentId);
    const source = document
      ? await input.repository.getSource(brain.organizationId, brain.id, document.sourceId)
      : undefined;
    if (
      !document ||
      document.lifecycle !== "active" ||
      document.reviewStatus === "rejected" ||
      !document.currentContentVersionId ||
      !source ||
      source.status !== "active" ||
      source.brainId !== brain.id
    ) {
      throw new TypeError("Brain document is unavailable.");
    }
    const version = await input.repository.getDocumentVersion(
      brain.organizationId,
      document.id,
      document.currentContentVersionId,
    );
    const rendition = version ? await brainTextRendition(input.repository, version) : undefined;
    if (!version?.mediaType || !rendition) {
      throw new TypeError(
        "Brain document text is not available yet; indexing may still be running or may have failed (see index health).",
      );
    }
    const reference = rendition.bodyRef;
    if (
      !artifactBucketAllowed(reference.bucket, input.bucket, input.legacyBuckets) ||
      !reference.key.startsWith(`organizations/${brain.organizationId}/brains/${brain.id}/`) ||
      !reference.versionId
    ) {
      throw new TypeError("Brain document rendition escaped its immutable content boundary.");
    }
    const response = await input.s3.send(
      new GetObjectCommand({
        Bucket: reference.bucket,
        Key: reference.key,
        VersionId: reference.versionId,
      }),
    );
    if (!response.Body) throw new TypeError("Brain document rendition body is unavailable.");
    const bytes = await response.Body.transformToByteArray();
    const actualHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (bytes.byteLength !== reference.byteSize || actualHash !== reference.sha256) {
      throw new TypeError(
        "Brain document rendition no longer matches canonical evidence metadata.",
      );
    }
    if (startByte >= bytes.byteLength) {
      throw new TypeError("Brain document startByte is outside the current rendition.");
    }
    let start = startByte;
    while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
    let end = Math.min(bytes.byteLength, start + maxBytes);
    while (end > start && end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    const excerpt = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end));
    const [currentSource, currentDocument, currentVersion, currentRendition] = await Promise.all([
      input.repository.getSource(brain.organizationId, brain.id, source.id),
      input.repository.getDocument(brain.organizationId, brain.id, document.id),
      input.repository.getDocumentVersion(brain.organizationId, document.id, version.id),
      input.repository.getDocumentRendition(brain.organizationId, version.id, rendition.id),
    ]);
    if (
      currentDocument?.version !== document.version ||
      currentDocument.lifecycle !== "active" ||
      currentDocument.reviewStatus === "rejected" ||
      currentDocument.sourceId !== source.id ||
      currentDocument.currentContentVersionId !== version.id ||
      currentSource?.version !== source.version ||
      currentSource.status !== "active" ||
      currentSource.brainId !== brain.id ||
      currentVersion?.contentHash !== version.contentHash ||
      currentRendition?.contentHash !== rendition.contentHash
    ) {
      throw new TypeError("Brain document changed before evidence disclosure.");
    }
    return {
      citation: {
        brainId: brain.id,
        chunkId: `${version.id}:bytes:${start}-${end}`,
        coordinates: { end, kind: "utf8-byte", start },
        documentId: document.id,
        documentVersionId: version.id,
        renditionId: rendition.id,
        sourceId: document.sourceId,
      },
      excerpt,
      mediaType: version.mediaType,
      ...(document.title ? { title: document.title } : {}),
    };
  };
}
