import { RuntimeApiError } from "./runtime-api-error.ts";

/**
 * Absolute URL of a thread's stream on the public stream gateway. Stream sessions are useless
 * without it, so a missing or malformed gateway origin fails session issuance instead of handing
 * clients an unreachable URL.
 */
export function threadStreamUrl(streamGatewayBaseUrl: string, threadId: string): string {
  let base: URL | undefined;
  try {
    base = new URL(streamGatewayBaseUrl.trim());
  } catch {
    base = undefined;
  }
  if (
    base?.protocol !== "https:" ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  ) {
    throw new RuntimeApiError(
      503,
      "stream_gateway_unavailable",
      "The stream gateway URL is not configured.",
    );
  }
  return new URL(`/v1/threads/${encodeURIComponent(threadId)}/stream`, base).toString();
}
