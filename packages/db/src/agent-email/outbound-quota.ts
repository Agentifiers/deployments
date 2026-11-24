import type { AgentEmailRepositoryContext } from "./persistence-context.ts";
import { withCanonicalRecordKeys, type PlatformRecord } from "../records/index.ts";

export function outboundQuotaCounter(
  organizationId: string,
  environmentId: string,
  window: string,
  expiresAt: string,
): Extract<PlatformRecord, { readonly itemType: "rate-limit-counter" }> {
  return withCanonicalRecordKeys({
    data: {
      count: 0,
      expiresAt,
      limitKey: "agent-email.outbound-message",
      organizationId,
      scopeId: environmentId,
      version: 0,
      window,
    },
    itemType: "rate-limit-counter" as const,
    ttl: Math.floor(Date.parse(expiresAt) / 1_000),
  }) as Extract<PlatformRecord, { readonly itemType: "rate-limit-counter" }>;
}

export async function readOutboundQuota(context: AgentEmailRepositoryContext, window: string) {
  const { database, failure, run, scope } = context;
  const expiresAt = new Date(
    Date.parse(`${window}T00:00:00.000Z`) + 24 * 60 * 60 * 1_000,
  ).toISOString();
  const identity = outboundQuotaCounter(
    scope.organizationId,
    scope.environmentId,
    window,
    expiresAt,
  );
  const persisted = await run(
    "get-outbound-quota",
    database.getRecord("usage", { pk: identity.pk, sk: identity.sk }, true),
  );
  if (!persisted) return undefined;
  if (
    persisted.itemType !== "rate-limit-counter" ||
    persisted.data.scopeId !== scope.environmentId ||
    persisted.data.limitKey !== "agent-email.outbound-message" ||
    persisted.data.window !== window ||
    (persisted.data.organizationId !== undefined &&
      persisted.data.organizationId !== scope.organizationId)
  ) {
    throw failure(
      "get-outbound-quota",
      new Error("The outbound quota counter does not match the environment and window."),
    );
  }
  return persisted;
}
