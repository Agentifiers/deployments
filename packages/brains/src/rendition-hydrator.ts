import type { BrainRenditionHydrator } from "./query-runtime.ts";

export interface BrainS3RenditionTransport {
  readonly getObject: (
    input: {
      readonly Bucket: string;
      readonly Key: string;
      readonly Range?: string;
      readonly VersionId: string;
    },
    options: { readonly abortSignal?: AbortSignal },
  ) => Promise<{ readonly Body?: { readonly transformToByteArray: () => Promise<Uint8Array> } }>;
}

const MAX_HYDRATED_RENDITION_BYTES = 8 * 1_024 * 1_024;

function decode(bytes: Uint8Array) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TypeError("Brain citation range is not valid UTF-8 evidence.");
  }
}

export function makeS3BrainRenditionHydrator(
  transport: BrainS3RenditionTransport,
): BrainRenditionHydrator {
  return {
    async hydrateExcerpt({ hit, rendition, signal }) {
      const options = signal ? { abortSignal: signal } : {};
      const coordinates = hit.coordinates;
      if (coordinates.kind !== rendition.coordinateSystem) {
        throw new TypeError("Brain citation and rendition coordinate systems differ.");
      }
      if (
        !Number.isSafeInteger(coordinates.start) ||
        !Number.isSafeInteger(coordinates.end) ||
        coordinates.start < 0 ||
        coordinates.end <= coordinates.start
      ) {
        throw new TypeError("Brain citation coordinates are invalid.");
      }
      if (
        rendition.bodyRef.byteSize > MAX_HYDRATED_RENDITION_BYTES ||
        coordinates.end > rendition.bodyRef.byteSize * 4
      ) {
        throw new TypeError("Brain citation exceeds the bounded rendition size.");
      }
      if (coordinates.kind === "utf8-byte") {
        if (coordinates.end > rendition.bodyRef.byteSize) {
          throw new TypeError("Brain citation byte range exceeds its rendition.");
        }
        const response = await transport.getObject(
          {
            Bucket: rendition.bodyRef.bucket,
            Key: rendition.bodyRef.key,
            Range: `bytes=${coordinates.start}-${coordinates.end - 1}`,
            VersionId: rendition.bodyRef.versionId,
          },
          options,
        );
        if (!response.Body) throw new Error("Brain rendition body is unavailable.");
        return decode(await response.Body.transformToByteArray());
      }
      if (coordinates.kind !== "unicode-scalar") {
        throw new TypeError(
          `Brain coordinate system ${coordinates.kind} requires a specialized hydrator.`,
        );
      }
      const response = await transport.getObject(
        {
          Bucket: rendition.bodyRef.bucket,
          Key: rendition.bodyRef.key,
          VersionId: rendition.bodyRef.versionId,
        },
        options,
      );
      if (!response.Body) throw new Error("Brain rendition body is unavailable.");
      const bytes = await response.Body.transformToByteArray();
      if (bytes.byteLength > MAX_HYDRATED_RENDITION_BYTES) {
        throw new TypeError("Brain rendition exceeds the hydration byte limit.");
      }
      const scalars = Array.from(decode(bytes));
      if (coordinates.end > scalars.length) {
        throw new TypeError("Brain citation scalar range exceeds its rendition.");
      }
      return scalars.slice(coordinates.start, coordinates.end).join("");
    },
  };
}
