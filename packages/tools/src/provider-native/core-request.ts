import {
  normalizePublicHttpsUrl,
  resolvePublicHttpsTarget,
  type DnsLookup,
} from "@deployments-ai/net-security";

import type { ProviderNativeRetryPolicy } from "./core-types.ts";

import { isPlainRecord, optionalToolString } from "./core-input.ts";

export type ProviderNativeRetryDecision = {
  readonly delayMs: number;
  readonly reason: "attempt_limit" | "non_retryable_status" | "retryable_status";
  readonly retry: boolean;
};

export function providerNativeRetryAfterMs(
  response: Response,
  headerName = "retry-after",
  nowMs = Date.now(),
): number | undefined {
  const raw = response.headers.get(headerName);
  if (!raw?.trim()) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/u.test(trimmed)) {
    const delay = Number(trimmed) * 1_000;
    return Number.isSafeInteger(delay) ? delay : undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, dateMs - nowMs);
}

export function providerNativeRetryDecision(
  policy: ProviderNativeRetryPolicy,
  response: Response,
  attempt: number,
  nowMs = Date.now(),
  retryAfterHeader = "retry-after",
): ProviderNativeRetryDecision {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Retry attempt must be a positive integer.");
  }
  if (attempt >= policy.maxAttempts) {
    return { delayMs: 0, reason: "attempt_limit", retry: false };
  }
  if (!policy.retryableStatusCodes.includes(response.status)) {
    return { delayMs: 0, reason: "non_retryable_status", retry: false };
  }
  const retryAfterMs =
    policy.respectRetryAfter !== false
      ? providerNativeRetryAfterMs(response, retryAfterHeader, nowMs)
      : undefined;
  const exponentialDelay = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** Math.max(0, attempt - 1),
  );
  return {
    delayMs:
      retryAfterMs === undefined ? exponentialDelay : Math.min(policy.maxDelayMs, retryAfterMs),
    reason: "retryable_status",
    retry: true,
  };
}

/**
 * Resolve an HTTPS origin for origin-policy providers (WordPress) without a fixed
 * host suffix allowlist. Rejects credentials-in-URL, non-HTTPS, and obvious private hosts.
 */
export function requireHttpsOriginBaseUrl(
  input: Record<string, unknown>,
  keys: readonly string[] = ["baseUrl", "origin", "originUrl", "siteUrl"],
): URL {
  let rawUrl: string | undefined;
  for (const key of keys) {
    rawUrl = optionalToolString(input, key);
    if (rawUrl) break;
  }
  if (!rawUrl) {
    throw new Error(`Tool input ${keys.join(" or ")} is required`);
  }
  try {
    const parsed = new URL(normalizePublicHttpsUrl(rawUrl));
    parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "";
    parsed.search = "";
    parsed.hash = "";
    return parsed;
  } catch (cause) {
    throw new Error("Tool input origin must be a public HTTPS URL", { cause });
  }
}

export function resolveProviderNativeRequestTarget(requestUrl: string, dnsLookup?: DnsLookup) {
  return resolvePublicHttpsTarget(requestUrl, dnsLookup ? { dnsLookup } : {});
}

export function propertyResourceTargetAuditMetadata(
  inputKeys: readonly string[] = ["propertyId", "property_id", "gaPropertyId"],
): unknown {
  return {
    resourceTargets: {
      requireProofWhenConstrained: true,
      selectors: [
        {
          constraintKey: "propertyId",
          defaultFromAuthorization: true,
          inputKeys: [...inputKeys],
          required: false,
        },
      ],
    },
  };
}

export function siteResourceTargetAuditMetadata(
  inputKeys: readonly string[] = ["siteUrl", "site", "site_url", "siteId"],
): unknown {
  return {
    resourceTargets: {
      requireProofWhenConstrained: true,
      selectors: [
        {
          constraintKey: "site",
          defaultFromAuthorization: true,
          inputKeys: [...inputKeys],
          required: false,
        },
      ],
    },
  };
}

export function originResourceTargetAuditMetadata(
  inputKeys: readonly string[] = ["baseUrl", "origin", "originUrl", "siteUrl"],
): unknown {
  return {
    resourceTargets: {
      requireProofWhenConstrained: true,
      selectors: [
        {
          constraintKey: "origin",
          defaultFromAuthorization: true,
          inputKeys: [...inputKeys],
          required: false,
        },
      ],
    },
  };
}

export function readDateRangeBounds(input: Record<string, unknown>): {
  readonly endDate?: string;
  readonly startDate?: string;
} {
  const dateRange = input.dateRange;
  if (typeof dateRange === "string" && dateRange.trim()) return {};
  const record = isPlainRecord(dateRange) ? dateRange : {};
  const startDate =
    optionalToolString(record, "startDate") ??
    optionalToolString(record, "since") ??
    optionalToolString(input, "startDate") ??
    optionalToolString(input, "since");
  const endDate =
    optionalToolString(record, "endDate") ??
    optionalToolString(record, "until") ??
    optionalToolString(input, "endDate") ??
    optionalToolString(input, "until");
  return {
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
  };
}
