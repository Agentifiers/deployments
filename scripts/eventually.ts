/** Polls `operation` once per second until it yields a value or `timeoutMs` elapses. */
export async function eventually<T>(
  label: string,
  timeoutMs: number,
  operation: () => Promise<T | undefined>,
) {
  const deadline = Date.now() + timeoutMs;
  let lastCause: unknown;
  while (Date.now() < deadline) {
    try {
      const result = await operation();
      if (result !== undefined) return result;
    } catch (cause) {
      lastCause = cause;
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`${label} did not complete within ${timeoutMs}ms.`, { cause: lastCause });
}
