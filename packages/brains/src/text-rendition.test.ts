import { describe, expect, test } from "bun:test";
import type { BrainDocumentRendition, BrainDocumentVersion } from "./models.ts";
import {
  brainNormalizedRendition,
  brainNormalizedTextKey,
  brainTextRendition,
} from "./text-rendition.ts";

const createdAt = "2026-10-03T06:00:00.000Z";

function version(id: string, mediaType: string): BrainDocumentVersion {
  return {
    brainId: "brain-1",
    contentHash: `sha256:${id}`,
    createdAt,
    documentId: "document-1",
    envelopeHash: "envelope",
    id,
    kind: "content",
    mediaType,
    organizationId: "org-1",
    originalRenditionId: `${id}-original`,
    sourceId: "source-1",
    sourceOrder: 1,
  };
}

function original(owner: BrainDocumentVersion): BrainDocumentRendition {
  return {
    bodyRef: {
      bucket: "content",
      byteSize: 10,
      contentType: owner.mediaType!,
      key: `organizations/org-1/brains/brain-1/uploads/${owner.id}`,
      sha256: owner.contentHash!,
      versionId: "s3-original",
    },
    brainId: owner.brainId,
    contentHash: owner.contentHash!,
    coordinateSystem: "utf8-byte",
    createdAt,
    documentId: owner.documentId,
    documentVersionId: owner.id,
    id: owner.originalRenditionId!,
    kind: "original",
    organizationId: owner.organizationId,
  };
}

function normalized(owner: BrainDocumentVersion) {
  return brainNormalizedRendition({
    createdAt,
    extraction: { facts: { kind: "html" }, truncated: false },
    original: original(owner),
    text: {
      bucket: "content",
      byteSize: 4,
      contentType: "text/plain; charset=utf-8",
      key: brainNormalizedTextKey(original(owner)),
      sha256: "sha256:text",
      versionId: "s3-text",
    },
  });
}

describe("Brain text renditions", () => {
  test("reads text media from the original and PDF or HTML from the normalized rendition", async () => {
    const markdown = version("version-md", "text/markdown");
    const pdf = version("version-pdf", "application/pdf");
    const html = version("version-html", "text/html");
    const image = version("version-png", "image/png");
    const stored = [original(markdown), original(pdf), normalized(pdf), original(html)];
    const repository = {
      getDocumentRendition: async (organizationId: string, versionId: string, id: string) =>
        stored.find(
          (rendition) =>
            rendition.organizationId === organizationId &&
            rendition.documentVersionId === versionId &&
            rendition.id === id,
        ),
    };

    expect(await brainTextRendition(repository, markdown)).toEqual(original(markdown));
    expect(await brainTextRendition(repository, pdf)).toEqual(normalized(pdf));
    expect(await brainTextRendition(repository, html)).toBeUndefined();
    expect(await brainTextRendition(repository, image)).toBeUndefined();
  });

  test("renders the version's content while its body carries the text's own hash", () => {
    const pdf = version("version-pdf", "application/pdf");
    const rendition = normalized(pdf);

    expect(rendition).toEqual({
      bodyRef: {
        bucket: "content",
        byteSize: 4,
        contentType: "text/plain; charset=utf-8",
        key: "organizations/org-1/brains/brain-1/document-versions/version-pdf/text/document-text-v1.txt",
        sha256: "sha256:text",
        versionId: "s3-text",
      },
      brainId: "brain-1",
      contentHash: "sha256:version-pdf",
      coordinateSystem: "utf8-byte",
      createdAt,
      documentId: "document-1",
      documentVersionId: "version-pdf",
      id: expect.stringMatching(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u),
      kind: "normalized",
      organizationId: "org-1",
      transformation: {
        extractor: "document-text-v1",
        facts: { kind: "html" },
        sourceRenditionId: "version-pdf-original",
        truncated: false,
      },
    });
    expect(normalized(pdf).id).toBe(rendition.id);
    expect(normalized(version("version-other", "application/pdf")).id).not.toBe(rendition.id);
  });
});
