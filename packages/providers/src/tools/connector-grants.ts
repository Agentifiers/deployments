import { hasRequiredScopes } from "./policy.ts";

export interface ConnectorGrantCandidate {
  readonly connectorAccountId: string;
  readonly connectorGrantId: string;
  readonly connectorProvider: string;
  readonly connectorStatus: string;
  readonly organizationId: string;
  readonly scopes: readonly string[];
}

export type ConnectorGrantSelection =
  | { readonly status: "selected"; readonly candidate: ConnectorGrantCandidate }
  | { readonly status: "ambiguous"; readonly candidateCount: number }
  | { readonly status: "none" };

export type ConnectorGrantDecision =
  | {
      readonly allowed: true;
      readonly connectorAccountId?: string;
      readonly connectorGrantId?: string;
      readonly connectorProvider?: string;
      readonly grantedScopes?: readonly string[];
    }
  | { readonly allowed: false; readonly reason: string };

export function normalizeConnectorScopes(scopes: unknown): string[] {
  let candidate = scopes;
  if (typeof candidate === "string" && candidate.trim().startsWith("[")) {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      candidate = [];
    }
  }
  const rawScopes = Array.isArray(candidate) ? candidate : [];
  return [
    ...new Set(
      rawScopes
        .filter((scope): scope is string => typeof scope === "string")
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ].toSorted();
}

export function resolveToolCallConnectorIds(input: {
  readonly connectorDecision: ConnectorGrantDecision;
  readonly requestedConnectorAccountId?: string;
}): { readonly connectorAccountId?: string; readonly connectorGrantId?: string } {
  if (!input.connectorDecision.allowed) {
    return input.requestedConnectorAccountId
      ? { connectorAccountId: input.requestedConnectorAccountId }
      : {};
  }

  return {
    ...(input.connectorDecision.connectorAccountId
      ? { connectorAccountId: input.connectorDecision.connectorAccountId }
      : {}),
    ...(input.connectorDecision.connectorGrantId
      ? { connectorGrantId: input.connectorDecision.connectorGrantId }
      : {}),
  };
}

export function selectConnectorGrantCandidate(
  candidates: readonly ConnectorGrantCandidate[],
  args: {
    readonly connectorProvider: string;
    readonly organizationId: string;
    readonly requiredScopes: readonly string[];
  },
): ConnectorGrantSelection {
  const matches = candidates.filter(
    (candidate) =>
      candidate.organizationId === args.organizationId &&
      candidate.connectorProvider === args.connectorProvider &&
      candidate.connectorStatus === "connected" &&
      hasRequiredScopes({
        grantedScopes: candidate.scopes,
        requiredScopes: args.requiredScopes,
      }),
  );
  const candidate = matches[0];
  if (!candidate) return { status: "none" };
  if (matches.length > 1) {
    return { status: "ambiguous", candidateCount: matches.length };
  }

  return { status: "selected", candidate };
}
