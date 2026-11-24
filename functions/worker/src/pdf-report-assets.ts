import { GetObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { RuntimeToolPreparationRetryableError } from "@deployments-ai/agent-runtime";
import {
  boundaryAdmitsEgress,
  key,
  type DataBoundary,
  type DynamoDatabaseService,
  type OrganizationDataBoundaryReader,
  workerPersistence,
} from "@deployments-ai/db";
import {
  BoundedRawBodyError,
  executePinnedHttpsWithSameOriginRedirects,
  NetSecurityError,
  readBoundedRawBody,
} from "@deployments-ai/net-security";
import type { PdfAssetInput, ResolvedPdfAsset } from "@deployments-ai/tools";
import { artifactBucketAllowed } from "./artifact-buckets.ts";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";
import { logicallyExpired } from "./builtin-tool-support.ts";

const MAX_PDF_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PDF_IMAGE_DIMENSION = 8_192;
const MAX_PDF_IMAGE_PIXELS = 16_777_216;
const MAX_PDF_ASSET_COUNT = 50;
const MAX_PDF_REMOTE_ASSET_TOTAL_MS = 30_000;
const MAX_PDF_TOTAL_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_PDF_TOTAL_IMAGE_PIXELS = 24_000_000;
const IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png"]);
const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export interface PdfAssetResolverOptions {
  readonly artifactBucket: string;
  readonly legacyArtifactBuckets?: readonly string[];
  readonly artifactS3: Pick<S3Client, "send">;
  readonly database: DynamoDatabaseService;
  /** Refuses `sourceUrl` assets for an organization whose data boundary excludes public egress. */
  readonly dataBoundaries: OrganizationDataBoundaryReader;
  readonly remoteRequest?: typeof executePinnedHttpsWithSameOriginRedirects;
}

type MeasuredPdfAsset = ResolvedPdfAsset & { readonly pixelCount: number };

function imageContentType(value: string | null | undefined) {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (!normalized || !IMAGE_CONTENT_TYPES.has(normalized)) {
    throw new TypeError("PDF assets must use image/png or image/jpeg content.");
  }
  return normalized;
}

function assertImageDimensions(width: number, height: number, format: "JPEG" | "PNG") {
  const pixelCount = width * height;
  if (
    width < 1 ||
    height < 1 ||
    width > MAX_PDF_IMAGE_DIMENSION ||
    height > MAX_PDF_IMAGE_DIMENSION ||
    pixelCount > MAX_PDF_IMAGE_PIXELS
  ) {
    throw new TypeError(
      `PDF ${format} dimensions must not exceed ${MAX_PDF_IMAGE_DIMENSION}px or ${MAX_PDF_IMAGE_PIXELS} pixels.`,
    );
  }
  return pixelCount;
}

function boundedJpegPixelCount(content: Uint8Array) {
  if (content.byteLength < 4 || content[0] !== 0xff || content[1] !== 0xd8) {
    throw new TypeError("PDF JPEG assets must start with a valid SOI marker.");
  }
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  let cursor = 2;
  while (cursor < content.byteLength) {
    if (content[cursor] !== 0xff) {
      throw new TypeError("PDF JPEG assets contain an invalid marker sequence.");
    }
    while (cursor < content.byteLength && content[cursor] === 0xff) cursor += 1;
    if (cursor >= content.byteLength) {
      throw new TypeError("PDF JPEG assets contain a truncated marker.");
    }
    const marker = content[cursor++]!;
    if (marker === 0x00 || marker === 0xd8) {
      throw new TypeError("PDF JPEG assets contain an invalid marker.");
    }
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (cursor + 2 > content.byteLength) {
      throw new TypeError("PDF JPEG assets contain a truncated segment length.");
    }
    const segmentLength = view.getUint16(cursor);
    if (segmentLength < 2 || cursor + segmentLength > content.byteLength) {
      throw new TypeError("PDF JPEG assets contain an invalid segment length.");
    }
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 8) {
        throw new TypeError("PDF JPEG assets contain an invalid SOF segment.");
      }
      const componentCount = content[cursor + 7]!;
      if (componentCount < 1 || segmentLength !== 8 + componentCount * 3) {
        throw new TypeError("PDF JPEG assets contain an invalid SOF component table.");
      }
      return assertImageDimensions(view.getUint16(cursor + 5), view.getUint16(cursor + 3), "JPEG");
    }
    cursor += segmentLength;
  }
  throw new TypeError("PDF JPEG assets must contain a valid SOF marker.");
}

function boundedImage(content: Uint8Array, contentType: string) {
  if (content.byteLength < 1 || content.byteLength > MAX_PDF_IMAGE_BYTES) {
    throw new TypeError(`PDF image assets must contain 1 to ${MAX_PDF_IMAGE_BYTES} bytes.`);
  }
  if (contentType === "image/png") {
    const validHeader =
      content.byteLength >= 24 &&
      PNG_SIGNATURE.every((value, index) => content[index] === value) &&
      Buffer.from(content.subarray(12, 16)).toString("ascii") === "IHDR";
    if (!validHeader) throw new TypeError("PDF PNG assets must contain a valid IHDR header.");
    const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return { content, pixelCount: assertImageDimensions(width, height, "PNG") };
  }
  return { content, pixelCount: boundedJpegPixelCount(content) };
}

function inlineAsset(asset: PdfAssetInput): MeasuredPdfAsset {
  const contentType = imageContentType(asset.contentType);
  const encoded = asset.contentBase64!;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new TypeError(`PDF asset ${asset.id} contentBase64 is invalid.`);
  }
  const measured = boundedImage(Uint8Array.from(Buffer.from(encoded, "base64")), contentType);
  const { content } = measured;
  if (Buffer.from(content).toString("base64") !== encoded) {
    throw new TypeError(`PDF asset ${asset.id} contentBase64 is not canonical.`);
  }
  return { ...measured, contentType, id: asset.id };
}

function retryableAssetFailure(
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  asset: PdfAssetInput,
  cause: unknown,
) {
  return new RuntimeToolPreparationRetryableError(
    request.toolName,
    new Error(`PDF asset ${asset.id} content was temporarily unavailable.`, { cause }),
  );
}

async function boundedResponseBody(
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  asset: PdfAssetInput,
  body: ReadableStream<Uint8Array> | null | undefined,
  contentLengthHeader?: string | null,
) {
  try {
    return await readBoundedRawBody(body, {
      ...(contentLengthHeader !== undefined ? { contentLengthHeader } : {}),
      maxBytes: MAX_PDF_IMAGE_BYTES,
    });
  } catch (cause) {
    if (
      cause instanceof BoundedRawBodyError &&
      (cause.code === "body_too_large" || cause.code === "invalid_content_length")
    ) {
      throw new TypeError(`PDF asset ${asset.id} content length is invalid.`, { cause });
    }
    throw retryableAssetFailure(request, asset, cause);
  }
}

async function storedAsset(
  options: PdfAssetResolverOptions,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  asset: PdfAssetInput,
): Promise<MeasuredPdfAsset> {
  let record;
  try {
    record = await workerPersistence.read(
      options.database,
      "execution",
      {
        pk: key("ORG", request.organizationId, "ENV", request.environmentId),
        sk: key("ARTIFACT", asset.artifactId!),
      },
      true,
    );
  } catch (cause) {
    throw retryableAssetFailure(request, asset, cause);
  }
  if (
    record?.itemType !== "artifact" ||
    record.data.organizationId !== request.organizationId ||
    record.data.projectId !== request.projectId ||
    record.data.environmentId !== request.environmentId ||
    record.data.status !== "available" ||
    logicallyExpired(record.data.retentionExpiresAt) ||
    (record.data.runId !== request.runId && record.data.visibility === "private") ||
    !artifactBucketAllowed(
      record.data.storage.bucket,
      options.artifactBucket,
      options.legacyArtifactBuckets,
    ) ||
    !record.data.storage.versionId ||
    record.data.storage.byteSize < 1 ||
    record.data.storage.byteSize > MAX_PDF_IMAGE_BYTES
  ) {
    throw new TypeError(`PDF asset ${asset.id} was not found in the current scope.`);
  }
  const contentType = imageContentType(record.data.storage.contentType);
  let response;
  try {
    response = await options.artifactS3.send(
      new GetObjectCommand({
        Bucket: record.data.storage.bucket,
        Key: record.data.storage.key,
        VersionId: record.data.storage.versionId,
      }),
    );
  } catch (cause) {
    throw retryableAssetFailure(request, asset, cause);
  }
  if (!response.Body) throw retryableAssetFailure(request, asset, "S3 returned no body.");
  const content = await boundedResponseBody(
    request,
    asset,
    response.Body.transformToWebStream(),
    response.ContentLength === undefined ? undefined : String(response.ContentLength),
  );
  const measured = boundedImage(content, contentType);
  if (measured.content.byteLength !== record.data.storage.byteSize) {
    throw new TypeError(`PDF asset ${asset.id} content did not match its storage metadata.`);
  }
  return { ...measured, contentType, id: asset.id };
}

async function readDataBoundary(
  options: PdfAssetResolverOptions,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
): Promise<DataBoundary> {
  try {
    return await options.dataBoundaries.read(request.organizationId);
  } catch (cause) {
    throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
  }
}

async function remoteAsset(
  options: PdfAssetResolverOptions,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  asset: PdfAssetInput,
  boundary: DataBoundary,
  deadlineSignal: AbortSignal,
): Promise<MeasuredPdfAsset> {
  if (!boundaryAdmitsEgress(boundary, "public")) {
    throw new TypeError(
      `PDF asset ${asset.id} sourceUrl is outside this organization's ${boundary.profile} data boundary; attach the image as an artifact instead.`,
    );
  }
  let url: URL;
  try {
    url = new URL(asset.sourceUrl!);
  } catch (cause) {
    throw new TypeError(`PDF asset ${asset.id} sourceUrl is invalid.`, { cause });
  }
  let result;
  try {
    if (deadlineSignal.aborted) throw deadlineSignal.reason;
    result = await (options.remoteRequest ?? executePinnedHttpsWithSameOriginRedirects)({
      signal: deadlineSignal,
      url,
      verifiedOrigin: url.origin,
    });
  } catch (cause) {
    if (cause instanceof NetSecurityError && cause.code !== "empty-dns") {
      throw new TypeError(`PDF asset ${asset.id} sourceUrl is not an allowed public URL.`, {
        cause,
      });
    }
    throw retryableAssetFailure(request, asset, cause);
  }
  if (result.response.status < 200 || result.response.status >= 300) {
    await result.response.body?.cancel();
    if ([408, 425, 429].includes(result.response.status) || result.response.status >= 500) {
      throw retryableAssetFailure(
        request,
        asset,
        new Error(`Remote server returned HTTP ${result.response.status}.`),
      );
    }
    throw new TypeError(`PDF asset ${asset.id} sourceUrl returned HTTP ${result.response.status}.`);
  }
  const contentType = imageContentType(result.response.headers.get("content-type"));
  const content = await boundedResponseBody(
    request,
    asset,
    result.response.body,
    result.response.headers.get("content-length"),
  );
  return { ...boundedImage(content, contentType), contentType, id: asset.id };
}

export async function resolvePdfAssets(
  options: PdfAssetResolverOptions,
  request: Parameters<ExecuteRuntimeBuiltinTool>[0],
  assets: readonly PdfAssetInput[],
  requiredAssetIds?: ReadonlySet<string>,
) {
  if (assets.length > MAX_PDF_ASSET_COUNT) {
    throw new TypeError(`PDF reports must not include more than ${MAX_PDF_ASSET_COUNT} assets.`);
  }
  const resolved = new Map<string, MeasuredPdfAsset>();
  const seenIds = new Set<string>();
  let totalBytes = 0;
  let totalPixels = 0;
  const remoteTimeout = AbortSignal.timeout(MAX_PDF_REMOTE_ASSET_TOTAL_MS);
  const remoteDeadline = request.signal
    ? AbortSignal.any([request.signal, remoteTimeout])
    : remoteTimeout;
  const boundary = assets.some((asset) => asset.sourceUrl !== undefined)
    ? await readDataBoundary(options, request)
    : undefined;
  for (const asset of assets) {
    if (!asset.id.trim() || seenIds.has(asset.id)) {
      throw new TypeError("PDF asset IDs must be non-empty and unique.");
    }
    seenIds.add(asset.id);
    const sources = [asset.artifactId, asset.contentBase64, asset.sourceUrl].filter(
      (value) => value !== undefined,
    );
    if (sources.length !== 1) {
      throw new TypeError(`PDF asset ${asset.id} must specify exactly one content source.`);
    }
    if (requiredAssetIds && !requiredAssetIds.has(asset.id)) continue;
    const value =
      asset.contentBase64 !== undefined
        ? inlineAsset(asset)
        : asset.artifactId !== undefined
          ? await storedAsset(options, request, asset)
          : await remoteAsset(options, request, asset, boundary!, remoteDeadline);
    totalBytes += value.content.byteLength;
    totalPixels += value.pixelCount;
    if (totalBytes > MAX_PDF_TOTAL_IMAGE_BYTES) {
      throw new TypeError(
        `PDF image assets exceed the ${MAX_PDF_TOTAL_IMAGE_BYTES}-byte aggregate limit.`,
      );
    }
    if (totalPixels > MAX_PDF_TOTAL_IMAGE_PIXELS) {
      throw new TypeError(
        `PDF image assets exceed the ${MAX_PDF_TOTAL_IMAGE_PIXELS}-pixel aggregate pixel limit.`,
      );
    }
    resolved.set(asset.id, value);
  }
  for (const assetId of requiredAssetIds ?? []) {
    if (!seenIds.has(assetId)) throw new TypeError(`PDF asset ${assetId} was not provided.`);
  }
  return resolved;
}
