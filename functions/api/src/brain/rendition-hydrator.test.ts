import { describe, expect, test } from "bun:test";
import type { BrainDocumentRendition, BrainSearchProviderHit } from "@deployments-ai/brains";
import { makeS3BrainRenditionHydrator } from "./rendition-hydrator.ts";

const text = "A😀 cited fact";
const bytes = new TextEncoder().encode(text);
const rendition: BrainDocumentRendition = {
  bodyRef: {
    bucket: "content",
    byteSize: bytes.byteLength,
    contentType: "text/plain",
    key: "organizations/org/brains/brain/rendition",
    sha256: "sha256:content",
    versionId: "s3-version-1",
  },
  brainId: "brain",
  contentHash: "sha256:content",
  coordinateSystem: "unicode-scalar",
  createdAt: "2026-07-30T12:00:00.000Z",
  documentId: "document",
  documentVersionId: "version",
  id: "rendition",
  kind: "normalized",
  organizationId: "org",
};

function hit(coordinates: BrainSearchProviderHit["coordinates"]) {
  return { coordinates } as BrainSearchProviderHit;
}

describe("Brain S3 rendition hydration", () => {
  test("slices Unicode scalar coordinates against one immutable S3 version", async () => {
    const requests: unknown[] = [];
    const hydrator = makeS3BrainRenditionHydrator({
      getObject: async (input) => {
        requests.push(input);
        return { Body: { transformToByteArray: async () => bytes } };
      },
    });
    expect(
      await hydrator.hydrateExcerpt({
        hit: hit({ end: 8, kind: "unicode-scalar", start: 3 }),
        rendition,
      }),
    ).toBe("cited");
    expect(requests[0]).toMatchObject({ VersionId: "s3-version-1" });
  });

  test("uses an exact bounded S3 range for UTF-8 byte coordinates", async () => {
    let range: string | undefined;
    const hydrator = makeS3BrainRenditionHydrator({
      getObject: async (input) => {
        range = input.Range;
        return {
          Body: { transformToByteArray: async () => new TextEncoder().encode("cited") },
        };
      },
    });
    expect(
      await hydrator.hydrateExcerpt({
        hit: hit({ end: 10, kind: "utf8-byte", start: 5 }),
        rendition: { ...rendition, coordinateSystem: "utf8-byte" },
      }),
    ).toBe("cited");
    expect(range).toBe("bytes=5-9");
  });
});
