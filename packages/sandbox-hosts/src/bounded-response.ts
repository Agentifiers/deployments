const MAX_SANDBOX_JSON_RESPONSE_BYTES = 49 * 1024 * 1024;
const MAX_SANDBOX_ERROR_BODY_BYTES = 8 * 1024;

async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
  context: string,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/u.test(contentLength) && Number(contentLength) > maximumBytes) {
    try {
      await response.body?.cancel();
    } catch {
      // The size violation is authoritative even if cancellation fails.
    }
    throw new Error(`${context} exceeds ${maximumBytes} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size violation is authoritative even if cancellation fails.
        }
        throw new Error(`${context} exceeds ${maximumBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function readSandboxJsonResponse(response: Response): Promise<unknown> {
  const body = await readBoundedResponseBytes(
    response,
    MAX_SANDBOX_JSON_RESPONSE_BYTES,
    "Sandbox JSON response",
  );
  return JSON.parse(new TextDecoder().decode(body));
}

export async function readErrorBody(response: Response): Promise<string> {
  try {
    const body = await readBoundedResponseBytes(
      response,
      MAX_SANDBOX_ERROR_BODY_BYTES,
      "Sandbox error response",
    );
    return new TextDecoder().decode(body);
  } catch {
    return "";
  }
}
