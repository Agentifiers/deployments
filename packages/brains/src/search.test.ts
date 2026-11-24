import { describe, expect, test } from "bun:test";
import type {
  Brain,
  BrainDocument,
  BrainDocumentRendition,
  BrainDocumentVersion,
  BrainSource,
} from "./models.ts";
import { searchBrains } from "./search.ts";
import type { BrainSearchProviderClient, BrainSearchProviderHit } from "./search-provider.ts";

const organizationId = "organization-1";
const brainId = "brain-1";
const documentId = "document-1";
const versionId = "version-1";
const sourceId = "source-1";
const renditionId = "rendition-1";
const timestamp = "2026-07-30T12:00:00.000Z";

const brain: Brain = {
  createdAt: timestamp,
  createdByPrincipalId: "principal-1",
  id: brainId,
  kind: "company",
  maintenancePolicy: {},
  name: "Engineering",
  organizationId,
  ownershipGeneration: 0,
  retrievalPolicy: {},
  schemaVersion: 1,
  sensitivity: "restricted",
  slug: "engineering",
  status: "active",
  updatedAt: timestamp,
  updatedByPrincipalId: "principal-1",
  version: 0,
};

const source: BrainSource = {
  brainId,
  createdAt: timestamp,
  createdByPrincipalId: "principal-1",
  id: sourceId,
  kind: "upload",
  name: "Uploads",
  organizationId,
  status: "active",
  updatedAt: timestamp,
  updatedByPrincipalId: "principal-1",
  version: 0,
};

const document: BrainDocument = {
  brainId,
  createdAt: timestamp,
  currentContentVersionId: versionId,
  currentEnvelopeHash: "envelope",
  currentSourceOrder: 1,
  currentVersionId: versionId,
  externalItemIdentity: "decision-42",
  id: documentId,
  lifecycle: "active",
  organizationId,
  projectionGeneration: 1,
  reviewStatus: "approved",
  sensitivity: "internal",
  sourceId,
  title: "Decision 42",
  updatedAt: timestamp,
  version: 0,
};

const version: BrainDocumentVersion = {
  brainId,
  createdAt: timestamp,
  documentId,
  envelopeHash: "envelope",
  id: versionId,
  bodyRef: {
    bucket: "content",
    byteSize: 20,
    contentType: "text/plain",
    key: "version-1/original",
    sha256: "content-hash",
    versionId: "s3-version-1",
  },
  byteSize: 20,
  contentHash: "content-hash",
  kind: "content",
  mediaType: "text/plain",
  organizationId,
  originalRenditionId: renditionId,
  sourceId,
  sourceOrder: 1,
};

function hit(overrides: Partial<BrainSearchProviderHit> = {}): BrainSearchProviderHit {
  return {
    brainId,
    chunkId: "chunk-1",
    contentHash: version.contentHash!,
    coordinates: { end: 20, kind: "unicode-scalar", start: 0 },
    denseScore: 0.8,
    documentId,
    documentVersionId: versionId,
    lexicalScore: 0.5,
    organizationId,
    projectionGeneration: document.projectionGeneration,
    renditionId: "rendition-1",
    sensitivity: "internal",
    reviewStatus: document.reviewStatus,
    schemaGeneration: 1,
    sourceId,
    ...overrides,
  };
}

const target = {
  location: {},
  providerId: "aws-native" as const,
  schemaGeneration: 1,
  targetId: "target-1",
};

const rendition: BrainDocumentRendition = {
  bodyRef: version.bodyRef!,
  brainId,
  contentHash: version.contentHash!,
  coordinateSystem: "unicode-scalar",
  createdAt: timestamp,
  documentId,
  documentVersionId: versionId,
  id: renditionId,
  kind: "normalized",
  organizationId,
};

interface CanonicalState {
  readonly brains?: readonly Brain[];
  readonly disclosable?: boolean;
  readonly document?: BrainDocument;
  readonly rendition?: BrainDocumentRendition;
  readonly source?: BrainSource;
}

interface Query extends CanonicalState {
  /** The canonical state every read sees once a hit has been hydrated. */
  readonly atDisclosure?: CanonicalState;
  readonly hits: readonly BrainSearchProviderHit[];
}

async function search(query: Query) {
  const reads: string[] = [];
  let state: CanonicalState = query;
  const results = await searchBrains({
    brains: query.brains ?? [brain],
    canonical: {
      authorizeDisclosure: async (candidateBrainId) => {
        reads.push(`disclose ${candidateBrainId}`);
        return (state.disclosable ?? true)
          ? (state.brains ?? [brain]).find((item) => item.id === candidateBrainId)
          : undefined;
      },
      getDocument: async (_brainId, candidateDocumentId) => {
        reads.push(`document ${candidateDocumentId}`);
        return candidateDocumentId === documentId ? (state.document ?? document) : undefined;
      },
      getRendition: async (candidateVersionId, candidateRenditionId) => {
        reads.push(`rendition ${candidateVersionId}/${candidateRenditionId}`);
        return candidateVersionId === versionId && candidateRenditionId === renditionId
          ? (state.rendition ?? rendition)
          : undefined;
      },
      getSource: async (_brainId, candidateSourceId) => {
        reads.push(`source ${candidateSourceId}`);
        return candidateSourceId === sourceId ? (state.source ?? source) : undefined;
      },
      getVersion: async (_documentId, candidateVersionId) => {
        reads.push(`version ${candidateVersionId}`);
        return candidateVersionId === versionId ? version : undefined;
      },
      hydrate: async ({ hit: { chunkId } }) => {
        state = { ...query, ...query.atDisclosure };
        return `evidence ${chunkId}`;
      },
    },
    embedding: [0.1, 0.2],
    limit: 10,
    organizationId,
    provider: {
      providerId: "aws-native",
      search: async () => query.hits,
      target,
    } as unknown as BrainSearchProviderClient,
    query: "What did we decide?",
    target,
  });
  return { excerpts: results.map((result) => result.excerpt), reads };
}

async function excerpts(query: Query) {
  return (await search(query)).excerpts;
}

describe("Brain canonical search revalidation", () => {
  test("authorizes disclosure and reads each canonical record once at hydration and once at disclosure", async () => {
    expect(
      await search({ hits: [hit({ chunkId: "a" }), hit({ chunkId: "b" }), hit({ chunkId: "c" })] }),
    ).toEqual({
      excerpts: ["evidence a", "evidence b", "evidence c"],
      reads: [
        `disclose ${brainId}`,
        `source ${sourceId}`,
        `document ${documentId}`,
        `version ${versionId}`,
        `rendition ${versionId}/${renditionId}`,
        `disclose ${brainId}`,
        `source ${sourceId}`,
        `document ${documentId}`,
        `version ${versionId}`,
      ],
    });
  });

  test("drops hydrated evidence when the document changes at disclosure", async () => {
    expect(
      await Promise.all([
        excerpts({
          atDisclosure: { document: { ...document, title: "Decision 43" } },
          hits: [hit()],
        }),
        excerpts({
          atDisclosure: { document: { ...document, lifecycle: "archived", version: 1 } },
          hits: [hit()],
        }),
      ]),
    ).toEqual([["evidence chunk-1"], []]);
  });

  test("drops hydrated evidence when its Brain, source, or grant changes at disclosure", async () => {
    expect(
      await Promise.all([
        excerpts({ atDisclosure: {}, hits: [hit()] }),
        excerpts({
          atDisclosure: { brains: [{ ...brain, status: "archived", version: 1 }] },
          hits: [hit()],
        }),
        excerpts({
          atDisclosure: { source: { ...source, status: "archived", version: 1 } },
          hits: [hit()],
        }),
        excerpts({ atDisclosure: { disclosable: false }, hits: [hit()] }),
      ]),
    ).toEqual([["evidence chunk-1"], [], [], []]);
  });

  test("a grant revoked after the query starts blocks disclosure of every hit", async () => {
    const hits = [hit({ chunkId: "a" }), hit({ chunkId: "b" })];
    expect([
      await excerpts({ disclosable: true, hits }),
      await excerpts({ disclosable: false, hits }),
    ]).toEqual([["evidence a", "evidence b"], []]);
  });

  test("keeps every per-hit tenant, Brain, document, source, version, and sensitivity check", async () => {
    expect(
      await excerpts({
        hits: [
          hit({ chunkId: "other-tenant", organizationId: "other-org" }),
          hit({ brainId: "not-authorized-at-query-start", chunkId: "unauthorized" }),
          hit({ chunkId: "stale-version", documentVersionId: "stale-version" }),
          hit({ chunkId: "stale-projection", projectionGeneration: 2 }),
          hit({ chunkId: "sensitivity-changed", sensitivity: "restricted" }),
          hit({ chunkId: "review-changed", reviewStatus: "unreviewed" }),
          hit({ chunkId: "content-changed", contentHash: "other-hash" }),
          hit({ chunkId: "missing-source", sourceId: "source-2" }),
          hit({ chunkId: "current" }),
        ],
      }),
    ).toEqual(["evidence current"]);
    expect(
      await Promise.all([
        excerpts({ document: { ...document, lifecycle: "archived" }, hits: [hit()] }),
        excerpts({ hits: [hit()], source: { ...source, status: "archived" } }),
        excerpts({ hits: [hit()], rendition: { ...rendition, contentHash: "other-hash" } }),
        excerpts({ brains: [{ ...brain, status: "archived" }], hits: [hit()] }),
        excerpts({ brains: [{ ...brain, organizationId: "other-org" }], hits: [hit()] }),
      ]),
    ).toEqual([[], [], [], [], []]);
  });

  test("rejects a provider resolved for a different physical target", async () => {
    expect(
      searchBrains({
        brains: [brain],
        canonical: {} as never,
        embedding: [],
        limit: 5,
        organizationId,
        provider: {
          providerId: "aws-native",
          target: { ...target, targetId: "wrong-target" },
        } as BrainSearchProviderClient,
        query: "question",
        target,
      }),
    ).rejects.toThrow("physical target");
  });
});
