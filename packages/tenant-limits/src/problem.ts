import type { RequestLimited } from "./request-limiter.ts";

export function organizationRateLimitedResult(limited: RequestLimited, requestId: string) {
  return {
    body: JSON.stringify({
      type: "https://docs.deployments.ai/errors/organization-rate-limited",
      title: "The organization exceeded its API request rate limit.",
      status: 429,
      code: "organization_rate_limited",
      detail: `This organization is limited to ${limited.ratePerSecond} requests per second with a burst of ${limited.burst}.`,
      requestId,
    }),
    headers: {
      "content-type": "application/problem+json",
      "retry-after": String(limited.retryAfterSeconds),
      "x-request-id": requestId,
    },
    statusCode: 429,
  };
}

export function organizationRateLimitedResponse(limited: RequestLimited, requestId: string) {
  const result = organizationRateLimitedResult(limited, requestId);
  return new Response(result.body, { headers: result.headers, status: result.statusCode });
}
