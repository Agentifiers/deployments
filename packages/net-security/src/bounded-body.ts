/* eslint-disable no-await-in-loop -- Redirect and DNS validation must complete serially so every hop is checked before the next request. */

export type ReadBoundedRawBodyErrorCode =
  | "body_too_large"
  | "body_truncated"
  | "body_length_mismatch"
  | "invalid_content_length"
  | "body_unavailable";

export class BoundedRawBodyError extends Error {
  readonly code: ReadBoundedRawBodyErrorCode;

  constructor(code: ReadBoundedRawBodyErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BoundedRawBodyError";
    this.code = code;
  }
}

export interface ReadBoundedRawBodyOptions {
  /**
   * Maximum accepted body size in bytes (inclusive). Must be a positive safe integer.
   */
  readonly maxBytes: number;
  /**
   * Optional Content-Length header value. When present and finite, oversized
   * declared lengths are rejected before streaming, and short reads after the
   * stream ends are treated as truncated.
   */
  readonly contentLengthHeader?: string | null;
}

function concatenateUint8Chunks(chunks: readonly Uint8Array[], totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseContentLengthHeader(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!/^\d+$/u.test(trimmed)) {
    throw new BoundedRawBodyError(
      "invalid_content_length",
      "Content-Length must be a non-negative integer.",
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new BoundedRawBodyError(
      "invalid_content_length",
      "Content-Length must be a non-negative safe integer.",
    );
  }
  return parsed;
}

/**
 * Read the exact request body bytes up to `maxBytes` without parsing JSON/form
 * content. Rejects oversized declared Content-Length, streams that exceed the
 * limit mid-read, and truncated bodies when Content-Length is declared.
 */
export async function readBoundedRawBody(
  body: ReadableStream<Uint8Array> | null | undefined,
  options: ReadBoundedRawBodyOptions,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
    throw new BoundedRawBodyError(
      "invalid_content_length",
      "maxBytes must be a positive safe integer.",
    );
  }

  const declaredLength = parseContentLengthHeader(options.contentLengthHeader);
  if (declaredLength !== undefined && declaredLength > options.maxBytes) {
    throw new BoundedRawBodyError(
      "body_too_large",
      `Request body exceeds maximum of ${options.maxBytes} bytes.`,
    );
  }

  if (!body) {
    if (declaredLength !== undefined && declaredLength > 0) {
      throw new BoundedRawBodyError(
        "body_truncated",
        "Request body is shorter than Content-Length.",
      );
    }
    return new Uint8Array();
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- stream chunks must be read sequentially.
      const result = await reader.read();
      if (result.done) break;
      if (!result.value) continue;
      totalBytes += result.value.byteLength;
      if (totalBytes > options.maxBytes) {
        // eslint-disable-next-line no-await-in-loop -- cancel before throwing.
        await reader.cancel();
        throw new BoundedRawBodyError(
          "body_too_large",
          `Request body exceeds maximum of ${options.maxBytes} bytes.`,
        );
      }
      // Fail closed on over-length streams relative to declared Content-Length.
      if (declaredLength !== undefined && totalBytes > declaredLength) {
        // eslint-disable-next-line no-await-in-loop -- cancel before throwing.
        await reader.cancel();
        throw new BoundedRawBodyError(
          "body_length_mismatch",
          "Request body is longer than Content-Length.",
        );
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== undefined && totalBytes < declaredLength) {
    throw new BoundedRawBodyError("body_truncated", "Request body is shorter than Content-Length.");
  }
  if (declaredLength !== undefined && totalBytes > declaredLength) {
    throw new BoundedRawBodyError(
      "body_length_mismatch",
      "Request body is longer than Content-Length.",
    );
  }

  return concatenateUint8Chunks(chunks, totalBytes);
}

/**
 * Convenience wrapper for Fetch/Hono Request-like objects.
 */
export async function readBoundedRequestRawBody(
  request: {
    readonly body: ReadableStream<Uint8Array> | null;
    readonly headers: { get(name: string): string | null };
  },
  options: { readonly maxBytes: number },
): Promise<Uint8Array> {
  return readBoundedRawBody(request.body, {
    maxBytes: options.maxBytes,
    contentLengthHeader: request.headers.get("content-length"),
  });
}
