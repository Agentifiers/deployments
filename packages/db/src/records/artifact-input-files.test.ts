import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { ArtifactRecord, inputFileTextKey } from "./artifacts.ts";
import { withCanonicalRecordKeys } from "./index.ts";

const id = (suffix: string) => `01ARZ3NDEKTSV4RRFFQ69G${suffix.padStart(4, "0")}`;
const NOW = "2026-10-07T12:00:00.000Z";
const SHA = "b".repeat(64);
const scope = { environmentId: id("3"), organizationId: id("1"), projectId: id("2") };
const inputArtifact = {
  createdAt: NOW,
  ...scope,
  id: id("4"),
  name: "q3.pdf",
  status: "available",
  storage: {
    bucket: "artifact-bucket",
    byteSize: 12,
    contentType: "application/pdf",
    fileName: "q3.pdf",
    key: `artifacts/organizations/${id("1")}/projects/${id("2")}/environments/${id("3")}/customer/${id("4")}/${SHA}/q3.pdf`,
    sha256: SHA,
    versionId: "source-v1",
  },
  type: "input",
  updatedAt: NOW,
  version: 1,
  visibility: "private",
};
const document = {
  kind: "document",
  mediaType: "application/pdf",
  summary: "PDF, 3 pages",
  text: {
    byteSize: 1_024,
    extractor: "document-text-v1",
    sha256: "c".repeat(64),
    truncated: false,
    versionId: "text-v1",
  },
};
const decodes = (data: Readonly<Record<string, unknown>>) =>
  Schema.is(ArtifactRecord)(withCanonicalRecordKeys({ data, itemType: "artifact" }));

describe("artifact input file resolution", () => {
  test("an available input artifact carries one resolution, or none when it completed before resolution existed", () => {
    expect(decodes({ ...inputArtifact, input: document })).toBe(true);
    expect(decodes({ ...inputArtifact, input: { kind: "unusable", reason: "no_text" } })).toBe(
      true,
    );
    expect(decodes(inputArtifact)).toBe(true);
    expect(
      decodes({ ...inputArtifact, input: { kind: "image", mediaType: "application/pdf" } }),
    ).toBe(false);
  });

  test("a pending upload or another artifact type carries no resolution", () => {
    expect(decodes({ ...inputArtifact, status: "pending" })).toBe(true);
    expect(decodes({ ...inputArtifact, input: document, status: "pending" })).toBe(false);
    expect(decodes({ ...inputArtifact, input: document, type: "report" })).toBe(false);
    expect(decodes({ ...inputArtifact, type: "report" })).toBe(true);
  });

  test("derives the text key two segments below the upload digest", () => {
    expect(inputFileTextKey(scope, id("4"), SHA)).toBe(
      `artifacts/organizations/${id("1")}/projects/${id("2")}/environments/${id("3")}/customer/${id("4")}/${SHA}/text/document-text-v1.txt`,
    );
  });
});
