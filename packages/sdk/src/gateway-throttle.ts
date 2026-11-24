const RESEND_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000] as const;

/**
 * API Gateway answers a throttled request itself, before any integration runs, so a resend cannot
 * repeat a side effect. The platform and the identity service send their own 429s, which callers
 * handle, so only the gateway's fixed body counts.
 */
async function isGatewayThrottle(response: Response): Promise<boolean> {
  if (response.status !== 429) return false;
  try {
    const body: unknown = await response.clone().json();
    return (
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      body.message === "Too Many Requests"
    );
  } catch {
    return false;
  }
}

/**
 * Resends while API Gateway throttles the request. Each `send` call must make a fresh attempt. An
 * abort of `signal` rejects with its reason, as `fetch` does, even when `send` ignores the signal.
 */
export async function resendGatewayThrottles(
  send: () => Promise<Response>,
  signal?: AbortSignal,
): Promise<Response> {
  let response = await send();
  for (const delayMs of RESEND_DELAYS_MS) {
    const throttled = await isGatewayThrottle(response);
    // An abort while the body is read fails the read, which would look like a different 429.
    signal?.throwIfAborted();
    if (!throttled) return response;
    await response.body?.cancel();
    const { promise: waited, resolve } = Promise.withResolvers<void>();
    const timer = setTimeout(resolve, delayMs);
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    // Removing the last listener from an AbortSignal.timeout signal cancels its timer in Bun.
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    await waited;
    signal?.throwIfAborted();
    response = await send();
  }
  return response;
}
