import { organizationRateLimitedResult } from "@deployments-ai/tenant-limits";
import type { GateDecision } from "./gate.ts";

type Refusal = Exclude<GateDecision, { readonly kind: "admitted" }>;

function organizationSuspendedResult(
  decision: Extract<Refusal, { readonly kind: "suspended" }>,
  requestId: string,
) {
  return {
    body: JSON.stringify({
      type: "https://docs.deployments.ai/errors/organization-suspended",
      title: "The organization is suspended.",
      status: 403,
      code: "organization_suspended",
      detail:
        "This organization can read its data and reduce access or activity, but cannot make other changes until every hold is released.",
      holds: decision.holds.map((hold) => ({
        customerMessage: hold.customerMessage,
        reason: hold.reason,
        since: hold.placedAt,
      })),
      requestId,
    }),
    headers: {
      "content-type": "application/problem+json",
      "x-request-id": requestId,
    },
    statusCode: 403,
  };
}

/** The HTTP answer to a refused request: 403 `organization_suspended` or 429 rate limited. */
export function organizationRefusalResult(decision: Refusal, requestId: string) {
  return decision.kind === "suspended"
    ? organizationSuspendedResult(decision, requestId)
    : organizationRateLimitedResult(decision, requestId);
}

export function organizationRefusalResponse(decision: Refusal, requestId: string) {
  const result = organizationRefusalResult(decision, requestId);
  return new Response(result.body, { headers: result.headers, status: result.statusCode });
}
