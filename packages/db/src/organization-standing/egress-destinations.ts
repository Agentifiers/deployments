import type { DataBoundary } from "./data-boundary.ts";

/**
 * Where one tool call would send organization data, read from its input. A `url` keeps the full
 * URL for the approver, since a path or query can carry patient data, and its normalized origin
 * for the allowlist. `recipient` is an email address or phone number; `search-query` is text sent
 * to public search engines.
 */
export type EgressDestination =
  | { readonly kind: "url"; readonly url: string; readonly origin: string }
  | { readonly kind: "recipient"; readonly address: string }
  | { readonly kind: "search-query"; readonly query: string };

/**
 * What a call's input says about where data goes. `unknown` means the destination cannot be read
 * from the input (model-written code, an LLM-backed extraction, or a tool no extractor knows);
 * no approver can judge it, so a restricted boundary always denies it.
 */
export type EgressDestinations =
  | { readonly kind: "known"; readonly destinations: readonly EgressDestination[] }
  | { readonly kind: "unknown"; readonly reason: string };

/** One origin an organization admin allows public-egress tools to reach without approval. */
export interface EgressAllowlistEntry {
  /** Normalized `https://host[:port]`, lowercase, no path. */
  readonly origin: string;
  readonly note?: string;
}

export type EgressDecision =
  | { readonly action: "allow" }
  | {
      readonly action: "require-approval";
      /** Destinations not on the allowlist, shown to the approver in full. */
      readonly destinations: readonly EgressDestination[];
    }
  | { readonly action: "deny"; readonly reason: string };

/**
 * Decides one public-egress tool call for a boundary: allow when every destination is a URL
 * on an allowlisted origin, ask a human when every destination is known, deny otherwise. A boundary
 * that admits public egress allows everything.
 */
export function decideEgress(
  boundary: DataBoundary,
  allowlist: readonly EgressAllowlistEntry[],
  destinations: EgressDestinations,
): EgressDecision {
  if (boundary.egress.has("public")) return { action: "allow" };
  if (destinations.kind === "unknown") return { action: "deny", reason: destinations.reason };
  if (destinations.destinations.length === 0) {
    return { action: "deny", reason: "The call names no destination this boundary can check." };
  }
  const allowed = new Set(allowlist.map((entry) => entry.origin));
  const pending = destinations.destinations.filter(
    (destination) => destination.kind !== "url" || !allowed.has(destination.origin),
  );
  return pending.length === 0
    ? { action: "allow" }
    : { action: "require-approval", destinations: pending };
}

/**
 * Normalizes an `https` URL or origin to `https://host[:port]`; undefined when it is not one.
 * Callers that build a `url` destination from tool input treat undefined as `unknown`.
 */
export function normalizeEgressOrigin(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return undefined;
  return url.origin.toLowerCase();
}

/** One line per destination, for an approver. */
export function describeEgressDestination(destination: EgressDestination): string {
  switch (destination.kind) {
    case "url":
      return destination.url;
    case "recipient":
      return `recipient ${destination.address}`;
    case "search-query":
      return `search query "${destination.query}"`;
  }
}
