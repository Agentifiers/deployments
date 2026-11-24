import { describe, expect, test } from "bun:test";
import { sha256 } from "./canonical.ts";
import {
  ORGANIZATION_ID,
  PRINCIPAL_ID,
  OPERATION_ID,
  record,
  harness,
} from "./governance-service-test-harness.ts";

const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB2";
const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB3";
const ARTIFACT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FB4";
const SOURCE = new TextEncoder().encode("%PDF-1.7 quarterly revenue");
const TEXT = new TextEncoder().encode("Quarterly revenue grew.");
const prefix = `artifacts/organizations/${ORGANIZATION_ID}/projects/${PROJECT_ID}/environments/${ENVIRONMENT_ID}/customer/${ARTIFACT_ID}/${sha256(SOURCE)}`;

describe("governance service", () => {
  test("erases the extracted text of an input document that has no retention date", async () => {
    const fixture = harness([
      record(
        "artifact",
        {
          createdAt: "2026-07-24T00:00:00.000Z",
          environmentId: ENVIRONMENT_ID,
          id: ARTIFACT_ID,
          input: {
            kind: "document",
            mediaType: "application/pdf",
            summary: "PDF, 1 page",
            text: {
              byteSize: TEXT.byteLength,
              extractor: "document-text-v1",
              sha256: sha256(TEXT),
              truncated: false,
              versionId: "text-version",
            },
          },
          name: "q3.pdf",
          projectId: PROJECT_ID,
          status: "available",
          storage: {
            bucket: "artifacts",
            byteSize: SOURCE.byteLength,
            contentType: "application/pdf",
            fileName: "q3.pdf",
            key: `${prefix}/q3.pdf`,
            sha256: sha256(SOURCE),
            versionId: "source-version",
          },
          type: "input",
          updatedAt: "2026-07-24T00:00:00.000Z",
          version: 1,
          visibility: "private",
        },
        "execution",
      ),
    ]);
    fixture.objects.set(`artifacts/${prefix}/q3.pdf`, SOURCE);
    fixture.objects.set(`artifacts/${prefix}/text/document-text-v1.txt`, TEXT);
    await fixture.service.requestOperation({
      idempotencyKey: "erase-input-document",
      kind: "tenant-erasure",
      operationId: OPERATION_ID,
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
    });

    await fixture.service.runOperation(ORGANIZATION_ID, OPERATION_ID);

    expect([...fixture.objects.keys()].filter((key) => key.startsWith("artifacts/"))).toEqual([]);
    expect(fixture.deletedAllVersions).toEqual([
      `artifacts/${prefix}/q3.pdf`,
      `artifacts/${prefix}/text/document-text-v1.txt`,
    ]);
  });
});
