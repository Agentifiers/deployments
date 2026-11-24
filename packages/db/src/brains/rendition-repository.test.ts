import { describe, expect, test } from "bun:test";
import type { BrainDocumentRendition } from "@deployments-ai/brains";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import {
  createOrAdoptBrainDocumentRendition,
  makeBrainRenditionRepository,
} from "./rendition-repository.ts";

const [organizationId, brainId, documentId, versionId, renditionId] = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
] as const;

const rendition: BrainDocumentRendition = {
  bodyRef: {
    bucket: "content",
    byteSize: 12,
    contentType: "text/plain; charset=utf-8",
    key: `organizations/${organizationId}/brains/${brainId}/document-versions/${versionId}/text/document-text-v1.txt`,
    sha256: "sha256:text",
    versionId: "s3-text-1",
  },
  brainId,
  contentHash: "sha256:pdf",
  coordinateSystem: "utf8-byte",
  createdAt: "2026-10-03T06:00:00.000Z",
  documentId,
  documentVersionId: versionId,
  id: renditionId,
  kind: "normalized",
  organizationId,
  transformation: { extractor: "document-text-v1", truncated: false },
};

describe("Brain derived renditions", () => {
  test("keeps the first writer's rendition when a racing attempt creates the same one", async () => {
    const dynamo = fakeDynamoDocumentClient();
    dynamo.put(
      "control",
      withCanonicalRecordKeys({
        data: {
          createdAt: rendition.createdAt,
          id: organizationId,
          name: "Deployments.ai",
          slug: "deployments-ai",
          status: "active",
          updatedAt: rendition.createdAt,
          version: 1,
        },
        itemType: "organization" as const,
      }),
    );
    const database = makeDynamoDatabase(dynamo.client);

    expect(await createOrAdoptBrainDocumentRendition({ database, rendition })).toEqual(rendition);
    expect(
      await createOrAdoptBrainDocumentRendition({
        database,
        rendition: {
          ...rendition,
          bodyRef: { ...rendition.bodyRef, versionId: "s3-text-2" },
          createdAt: "2026-10-03T06:05:00.000Z",
        },
      }),
    ).toEqual(rendition);
    expect(
      await makeBrainRenditionRepository(database).getDocumentRendition(
        organizationId,
        versionId,
        renditionId,
      ),
    ).toEqual(rendition);
  });
});
