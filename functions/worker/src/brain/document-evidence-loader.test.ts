import { describe, expect, test } from "bun:test";
import {
  brainNormalizedRendition,
  brainNormalizedTextKey,
  type Brain,
  type BrainDocumentRendition,
  type BrainRepository,
} from "@deployments-ai/brains";
import { createHash } from "node:crypto";
import { createBrainDocumentEvidenceLoader } from "./document-evidence-loader.ts";

const brain: Brain = {
  createdAt: "2026-07-31T00:00:00.000Z",
  createdByPrincipalId: "principal-1",
  id: "brain-1",
  kind: "company",
  maintenancePolicy: {},
  name: "Company Brain",
  organizationId: "organization-1",
  ownershipGeneration: 0,
  retrievalPolicy: {},
  schemaVersion: 1,
  sensitivity: "internal",
  slug: "company-brain",
  status: "active",
  updatedAt: "2026-07-31T00:00:00.000Z",
  updatedByPrincipalId: "principal-1",
  version: 0,
};
const body = new TextEncoder().encode("current evidence");
const contentHash = `sha256:${createHash("sha256").update(body).digest("hex")}`;

function repository(input: {
  readonly reviewStatus?: "approved" | "rejected";
  readonly sourceStatuses: readonly ("active" | "paused")[];
}) {
  let sourceRead = 0;
  return {
    getDocument: async () => ({
      brainId: brain.id,
      createdAt: brain.createdAt,
      currentContentVersionId: "version-1",
      externalItemIdentity: "item-1",
      id: "document-1",
      lifecycle: "active" as const,
      organizationId: brain.organizationId,
      projectionGeneration: 1,
      reviewStatus: input.reviewStatus ?? ("approved" as const),
      sensitivity: "internal" as const,
      sourceId: "source-1",
      updatedAt: brain.updatedAt,
      version: 0,
    }),
    getDocumentRendition: async () => ({
      bodyRef: {
        bucket: "content",
        byteSize: body.byteLength,
        contentType: "text/plain",
        key: `organizations/${brain.organizationId}/brains/${brain.id}/evidence`,
        sha256: contentHash,
        versionId: "s3-version-1",
      },
      brainId: brain.id,
      contentHash,
      coordinateSystem: "utf8-byte" as const,
      createdAt: brain.createdAt,
      documentId: "document-1",
      documentVersionId: "version-1",
      id: "rendition-1",
      kind: "original" as const,
      organizationId: brain.organizationId,
    }),
    getDocumentVersion: async () => ({
      bodyRef: {
        bucket: "content",
        byteSize: body.byteLength,
        contentType: "text/plain",
        key: `organizations/${brain.organizationId}/brains/${brain.id}/evidence`,
        sha256: contentHash,
        versionId: "s3-version-1",
      },
      brainId: brain.id,
      byteSize: body.byteLength,
      contentHash,
      createdAt: brain.createdAt,
      documentId: "document-1",
      envelopeHash: "envelope-1",
      id: "version-1",
      kind: "content" as const,
      mediaType: "text/plain",
      organizationId: brain.organizationId,
      originalRenditionId: "rendition-1",
      sourceId: "source-1",
      sourceOrder: 1,
    }),
    getSource: async () => {
      const status = input.sourceStatuses[Math.min(sourceRead, input.sourceStatuses.length - 1)]!;
      sourceRead += 1;
      return {
        brainId: brain.id,
        createdAt: brain.createdAt,
        createdByPrincipalId: "principal-1",
        id: "source-1",
        kind: "upload" as const,
        name: "Source",
        organizationId: brain.organizationId,
        status,
        updatedAt: brain.updatedAt,
        updatedByPrincipalId: "principal-1",
        version: status === "active" ? 0 : 1,
      };
    },
  } as unknown as BrainRepository;
}

const pdf = new TextEncoder().encode("%PDF-1.7\n%%EOF");
const pdfHash = `sha256:${createHash("sha256").update(pdf).digest("hex")}`;
const pdfText = new TextEncoder().encode(
  "--- Page 1 ---\nRevenue summary\f--- Page 2 ---\nNorth region grew 8%",
);
const pdfOriginal: BrainDocumentRendition = {
  bodyRef: {
    bucket: "content",
    byteSize: pdf.byteLength,
    contentType: "application/pdf",
    key: `organizations/${brain.organizationId}/brains/${brain.id}/uploads/version-1`,
    sha256: pdfHash,
    versionId: "s3-pdf",
  },
  brainId: brain.id,
  contentHash: pdfHash,
  coordinateSystem: "utf8-byte",
  createdAt: brain.createdAt,
  documentId: "document-1",
  documentVersionId: "version-1",
  id: "rendition-1",
  kind: "original",
  organizationId: brain.organizationId,
};
const pdfNormalized = brainNormalizedRendition({
  createdAt: brain.createdAt,
  extraction: { facts: { kind: "pdf", pages: 2, pagesWithText: 2 }, truncated: false },
  original: pdfOriginal,
  text: {
    bucket: "content",
    byteSize: pdfText.byteLength,
    contentType: "text/plain; charset=utf-8",
    key: brainNormalizedTextKey(pdfOriginal),
    sha256: `sha256:${createHash("sha256").update(pdfText).digest("hex")}`,
    versionId: "s3-text",
  },
});

function pdfRepository(renditions: readonly BrainDocumentRendition[]) {
  const base = repository({ sourceStatuses: ["active"] });
  return {
    ...base,
    getDocumentRendition: async (_organizationId: string, versionId: string, id: string) =>
      renditions.find(
        (rendition) => rendition.documentVersionId === versionId && rendition.id === id,
      ),
    getDocumentVersion: async () => ({
      ...(await base.getDocumentVersion(brain.organizationId, "document-1", "version-1"))!,
      bodyRef: pdfOriginal.bodyRef,
      byteSize: pdf.byteLength,
      contentHash: pdfHash,
      mediaType: "application/pdf",
    }),
  } satisfies BrainRepository;
}

const objects = {
  send: async (command: { readonly input: { readonly Key?: string } }) => ({
    Body: {
      transformToByteArray: async () =>
        command.input.Key === pdfNormalized.bodyRef.key ? pdfText : pdf,
    },
  }),
} as never;

describe("Brain document evidence disclosure", () => {
  test("rejects a source revoked while immutable bytes are being loaded", async () => {
    const loader = createBrainDocumentEvidenceLoader({
      bucket: "content",
      repository: repository({ sourceStatuses: ["active", "paused"] }),
      s3: {
        send: async () => ({
          Body: { transformToByteArray: async () => body },
        }),
      } as never,
    });

    expect(
      loader({ brain, documentId: "document-1", maxBytes: 1_024, startByte: 0 }),
    ).rejects.toThrow("changed before evidence disclosure");
  });

  test("rejects a reviewed-out document before reading S3", async () => {
    let reads = 0;
    const loader = createBrainDocumentEvidenceLoader({
      bucket: "content",
      repository: repository({ reviewStatus: "rejected", sourceStatuses: ["active"] }),
      s3: {
        send: async () => {
          reads += 1;
          return {};
        },
      } as never,
    });

    expect(
      loader({ brain, documentId: "document-1", maxBytes: 1_024, startByte: 0 }),
    ).rejects.toThrow("unavailable");
    expect(reads).toBe(0);
  });

  test("reads page 2 of a PDF from its normalized text rendition", async () => {
    const loader = createBrainDocumentEvidenceLoader({
      bucket: "content",
      repository: pdfRepository([pdfOriginal, pdfNormalized]),
      s3: objects,
    });
    const pageTwo = pdfText.indexOf(0x0c) + 1;

    expect(
      await loader({ brain, documentId: "document-1", maxBytes: 1_024, startByte: pageTwo }),
    ).toEqual({
      citation: {
        brainId: brain.id,
        chunkId: `version-1:bytes:${pageTwo}-${pdfText.byteLength}`,
        coordinates: { end: pdfText.byteLength, kind: "utf8-byte", start: pageTwo },
        documentId: "document-1",
        documentVersionId: "version-1",
        renditionId: pdfNormalized.id,
        sourceId: "source-1",
      },
      excerpt: "--- Page 2 ---\nNorth region grew 8%",
      mediaType: "application/pdf",
    });
  });

  test("says a PDF's text is not available until indexing extracts it", async () => {
    const loader = createBrainDocumentEvidenceLoader({
      bucket: "content",
      repository: pdfRepository([pdfOriginal]),
      s3: objects,
    });

    expect(
      loader({ brain, documentId: "document-1", maxBytes: 1_024, startByte: 0 }),
    ).rejects.toThrow(
      "Brain document text is not available yet; indexing may still be running or may have failed (see index health).",
    );
  });
});
