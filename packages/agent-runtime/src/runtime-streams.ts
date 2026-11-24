export async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  label: string,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      byteLength += result.value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel(`Capture ${label} exceeded ${maximumBytes} bytes.`);
        throw new Error(`Sandbox capture ${label} exceeds its maximum size.`);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const content = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}
