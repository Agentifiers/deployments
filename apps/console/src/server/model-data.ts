import "@tanstack/react-start/server-only";
import type { ModelCatalogItem, ModelPolicyResponse } from "@deployments-ai/api-contract/models";
import { effectiveModelPolicy } from "@deployments-ai/model-gateway/model-policy";
import type { ModelSearch } from "../models/model-catalog-state.ts";
import {
  MAX_SCAN_RELEASES,
  modelPolicyImpact,
  policyRuleCheck,
  type ModelImpact,
} from "../models/model-impact.ts";
import type { NextRules } from "../models/model-policy-state.ts";
import { collectPagesUpTo } from "../overview/status-counts.ts";
import type { EnvironmentScope } from "../scope.ts";
import { API_PAGE_LIMIT, fillPage, PAGE_SIZE, type Page } from "./list-pages.ts";
import { callRoute } from "./platform-api.ts";
import { loadReleaseFacts } from "./release-facts.ts";

const MAX_SCAN_PAGES = 20;

export interface ModelCatalogPage extends Page<ModelCatalogItem> {
  readonly policy: { readonly source: "curated_defaults" | "model_policy" };
}

export async function loadModelPage(
  accessToken: string,
  scope: EnvironmentScope,
  search: ModelSearch,
  cursor: string | undefined,
): Promise<ModelCatalogPage> {
  const page = await callRoute(
    "listModels",
    { query: { ...search, cursor, limit: PAGE_SIZE }, scope },
    accessToken,
  );
  return {
    items: page.items,
    policy: { source: page.policy.source },
    ...(page.nextCursor === null ? {} : { nextCursor: page.nextCursor }),
  };
}

export async function loadActiveModelPolicy(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<ModelPolicyResponse | null> {
  const { policy } = await callRoute("listModels", { query: { limit: 1 }, scope }, accessToken);
  return policy.modelPolicyId === undefined
    ? null
    : callRoute("getModelPolicy", { path: { id: policy.modelPolicyId }, scope }, accessToken);
}

export function loadModelPolicyPage(
  accessToken: string,
  scope: EnvironmentScope,
  cursor: string | undefined,
): Promise<Page<ModelPolicyResponse>> {
  return fillPage(
    async (pageCursor, limit) => {
      const page = await callRoute(
        "listModelPolicies",
        { query: { cursor: pageCursor, limit }, scope },
        accessToken,
      );
      return { items: page.items, nextCursor: page.nextCursor ?? undefined };
    },
    cursor,
    PAGE_SIZE,
  );
}

export interface ModelPolicyPreview {
  readonly issues: readonly { readonly entry: string; readonly message: string }[];
  /** Exact entries past the catalog read, checked only by the API on save. */
  readonly unchecked: readonly string[];
  readonly impact: ModelImpact;
  readonly agentNames: Readonly<Record<string, string>>;
}

export async function loadModelPolicyPreview(
  accessToken: string,
  scope: EnvironmentScope,
  next: NextRules,
): Promise<ModelPolicyPreview> {
  const [active, deployments, catalog, definitions] = await Promise.all([
    loadActiveModelPolicy(accessToken, scope),
    collectPagesUpTo(
      (cursor) =>
        callRoute(
          "listAgentDeployments",
          { query: { cursor, limit: API_PAGE_LIMIT }, scope },
          accessToken,
        ),
      MAX_SCAN_PAGES,
    ),
    collectPagesUpTo(
      (cursor) =>
        callRoute("listModels", { query: { cursor, limit: API_PAGE_LIMIT }, scope }, accessToken),
      MAX_SCAN_PAGES,
    ),
    collectPagesUpTo(
      (cursor) =>
        callRoute(
          "listAgentDefinitions",
          { query: { cursor, limit: API_PAGE_LIMIT }, scope },
          accessToken,
        ),
      MAX_SCAN_PAGES,
    ),
  ]);
  const liveReleaseIds = [
    ...new Set(
      deployments.items
        .filter((deployment) => deployment.desiredState !== "stopped")
        .flatMap(({ agentReleaseId, candidateAgentReleaseId }) =>
          candidateAgentReleaseId ? [agentReleaseId, candidateAgentReleaseId] : [agentReleaseId],
        ),
    ),
  ];
  const releases = await loadReleaseFacts(
    accessToken,
    scope,
    liveReleaseIds.slice(0, MAX_SCAN_RELEASES),
  );
  const synced = new Set(catalog.items.map((item) => item.modelId));
  const impact = modelPolicyImpact({
    current: effectiveModelPolicy(active ?? undefined),
    deployments: deployments.items,
    facts: {
      allowedNow: new Map(catalog.items.map((item) => [item.modelId, item.allowed])),
      synced,
    },
    listsComplete: deployments.complete && catalog.complete,
    next: effectiveModelPolicy(next ? { id: active?.id ?? "", ...next } : undefined),
    releases,
  });
  const shown = new Set(
    [...impact.newlyDenied, ...impact.alreadyDenied].map((release) => release.agentDefinitionId),
  );
  return {
    agentNames: Object.fromEntries(
      definitions.items
        .filter((definition) => shown.has(definition.id))
        .map((definition) => [definition.id, definition.name]),
    ),
    impact,
    ...(next
      ? policyRuleCheck(next, { complete: catalog.complete, ids: synced })
      : { issues: [], unchecked: [] }),
  };
}
