import { describe, expect, test } from "bun:test";
import {
  BrainDocumentResponse,
  BrainEntityEvidenceResponse,
  BrainReviewItemResponse,
} from "@deployments-ai/api-contract/brains";
import { Schema } from "effect";
import {
  documentView,
  entityView,
  lifecycleCapture,
  lifecycleKinds,
  resolveBody,
  reviewDecisions,
  reviewItemView,
} from "./content.ts";

const BRAIN = "01K0000000000000000000000D";
const ORG = "01K0000000000000000000000A";
const SOURCE = "01K0000000000000000000000E";
const DOCUMENT = "01K0000000000000000000000F";
const CONTENT_VERSION = "01K0000000000000000000000G";
const ENTITY = "01K0000000000000000000000J";
const AT = "2026-10-09T12:00:00.000Z";

const documentFields = {
  brainId: BRAIN,
  createdAt: AT,
  currentContentVersionId: CONTENT_VERSION,
  currentVersionId: CONTENT_VERSION,
  externalItemIdentity: "handbook.md",
  id: DOCUMENT,
  lifecycle: "active",
  organizationId: ORG,
  projectionGeneration: 0,
  reviewStatus: "unreviewed",
  sensitivity: "internal",
  sourceId: SOURCE,
  updatedAt: AT,
  version: 0,
};

const versionFields = {
  brainId: BRAIN,
  byteSize: 12,
  createdAt: AT,
  documentId: DOCUMENT,
  envelopeHash: "e1",
  id: CONTENT_VERSION,
  kind: "content",
  mediaType: "text/markdown",
  organizationId: ORG,
  sourceId: SOURCE,
  sourceOrder: 0,
};

const decodeDocument = Schema.decodeUnknownSync(BrainDocumentResponse);
const decodeReviewItem = Schema.decodeUnknownSync(BrainReviewItemResponse);
const decodeEntity = Schema.decodeUnknownSync(BrainEntityEvidenceResponse);

const documentIn = (
  lifecycle: string,
  fields: Readonly<Record<string, unknown>> = documentFields,
) => decodeDocument({ document: { ...fields, lifecycle }, version: versionFields }).document;

const reviewItem = (kind: string, proposal: Readonly<Record<string, unknown>>) =>
  reviewItemView(
    decodeReviewItem({
      brainId: BRAIN,
      createdAt: AT,
      id: "01K0000000000000000000000H",
      kind,
      organizationId: ORG,
      proposal,
      reason: "Flagged by maintenance.",
      status: "open",
      updatedAt: AT,
      version: 3,
    }),
  );

describe("documentView", () => {
  test("drops the S3 body reference and keeps everything else", () => {
    const bodyRef = {
      bucket: "brain-content",
      byteSize: 12,
      contentType: "text/markdown",
      key: "organizations/o/brains/b/original",
      sha256: "abc",
      versionId: "v1",
    };
    expect<unknown>(
      documentView(
        decodeDocument({ document: documentFields, version: { ...versionFields, bodyRef } }),
      ),
    ).toEqual({ document: documentFields, version: versionFields });
  });
});

describe("lifecycle captures", () => {
  test("offers the moves each lifecycle allows", () => {
    expect(lifecycleKinds(documentIn("active"))).toEqual(["archive", "tombstone"]);
    expect(lifecycleKinds(documentIn("archived"))).toEqual(["restore", "tombstone"]);
    expect(lifecycleKinds(documentIn("deleted"))).toEqual(["restore"]);
    const { currentContentVersionId: _none, ...contentless } = documentFields;
    expect(lifecycleKinds(documentIn("deleted", contentless))).toEqual([]);
  });

  test("restores the content version the document last held", () => {
    expect(lifecycleCapture(documentIn("deleted"), "restore")).toEqual({
      externalItemIdentity: "handbook.md",
      kind: "restore",
      restoredContentVersionId: CONTENT_VERSION,
    });
    expect(lifecycleCapture(documentIn("active"), "tombstone")).toEqual({
      externalItemIdentity: "handbook.md",
      kind: "tombstone",
    });
  });
});

describe("review items", () => {
  test("an entity merge offers merge onto one of its candidates", () => {
    const item = reviewItem("entity-merge", {
      aliases: ["acme"],
      candidateEntityIds: ["E1", "E2", 7],
    });
    expect(item.proposal).toEqual({
      aliases: ["acme"],
      candidateEntityIds: ["E1", "E2"],
      kind: "entity-merge",
    });
    expect(reviewDecisions(item)).toEqual(["merge", "approve", "reject"]);
    expect(resolveBody(item, { decision: "merge", targetEntityId: "E2" })).toEqual({
      decision: "merge",
      expectedVersion: 3,
      targetEntityId: "E2",
    });
  });

  test("other kinds only record approve or reject", () => {
    const summary = reviewItem("summary", { text: "x" });
    expect(summary.proposal).toEqual({ kind: "other" });
    expect(reviewDecisions(summary)).toEqual(["approve", "reject"]);
    expect(resolveBody(summary, { decision: "reject" })).toEqual({
      decision: "reject",
      expectedVersion: 3,
    });
  });

  test("a duplicate-document item offers no decision the platform can record", () => {
    const duplicate = reviewItem("duplicate-document", {
      contentHash: "sha256:x",
      documentIds: ["D1", "D2"],
    });
    expect(duplicate.proposal).toEqual({ documentIds: ["D1", "D2"], kind: "duplicate-document" });
    expect(reviewDecisions(duplicate)).toEqual([]);
  });
});

describe("entityView", () => {
  test("drops free-form identifiers and edge evidence", () => {
    const entity = {
      brainId: BRAIN,
      canonicalName: "Acme",
      createdAt: AT,
      id: ENTITY,
      kind: "company",
      normalizedAliases: ["acme"],
      organizationId: ORG,
      reviewStatus: "unreviewed",
      status: "active",
      updatedAt: AT,
      version: 0,
    };
    const edge = {
      brainId: BRAIN,
      confidence: 0.9,
      createdAt: AT,
      documentVersionId: CONTENT_VERSION,
      extractionMethod: "model",
      from: { id: DOCUMENT, kind: "document" },
      id: "01K0000000000000000000000K",
      lifecycle: "active",
      organizationId: ORG,
      relation: "mentions",
      renditionId: "01K0000000000000000000000M",
      reviewStatus: "unreviewed",
      to: { id: ENTITY, kind: "entity" },
      updatedAt: AT,
      version: 0,
    };
    expect<unknown>(
      entityView(
        decodeEntity({
          edges: [{ ...edge, evidence: { quote: "Acme" } }],
          entity: { ...entity, externalIdentifiers: { crm: "1" } },
        }),
      ),
    ).toEqual({ edges: [edge], entity });
  });
});
