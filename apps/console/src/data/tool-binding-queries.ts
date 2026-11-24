import { AgentToolName } from "@deployments-ai/agent-manifest/schema";
import { TOOL_POLICY_EVALUATION_MAX_TOOLS } from "@deployments-ai/api-contract/tool-catalog";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { Schema } from "effect";
import type { EnvironmentScope } from "../scope.ts";
import {
  loadBindingPreview,
  loadBindingWorkbench,
  type WorkbenchRequest,
} from "../server/tool-binding-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { agentKey } from "./agent-queries.ts";
import { fields, requireIds, scopedInput } from "./server-input.ts";

/** Every tool a manifest can declare, which bounds one preview. */
const MAX_PREVIEW_TOOLS = 256;
const isToolName = Schema.is(AgentToolName);

export type PreviewGroup = {
  readonly toolNames: readonly string[];
  readonly toolPolicyId: string;
};

function workbenchRequest(input: unknown): WorkbenchRequest {
  const value = fields(input);
  if (value.kind === "edit") {
    return {
      kind: "edit",
      ...requireIds(value, ["definitionId", "deploymentId"]),
    };
  }
  if (value.kind !== "deploy") throw new TypeError("kind must be edit or deploy.");
  return {
    kind: "deploy",
    ...requireIds(value, ["definitionId", "releaseId"]),
    ...(value.seedDeploymentId === undefined
      ? {}
      : requireIds({ seedDeploymentId: value.seedDeploymentId }, ["seedDeploymentId"])),
  };
}

function previewGroups(input: unknown): PreviewGroup[] {
  if (!Array.isArray(input)) throw new TypeError("groups must be a list.");
  const groups = input.map((group: unknown) => {
    const { toolNames } = fields(group);
    const names = Array.isArray(toolNames) ? toolNames.filter(isToolName) : [];
    if (
      !Array.isArray(toolNames) ||
      names.length === 0 ||
      names.length !== toolNames.length ||
      names.length > TOOL_POLICY_EVALUATION_MAX_TOOLS
    ) {
      throw new TypeError("toolNames must list 1 to 100 tool names.");
    }
    return { ...requireIds(group, ["toolPolicyId"]), toolNames: names };
  });
  if (groups.reduce((total, { toolNames }) => total + toolNames.length, 0) > MAX_PREVIEW_TOOLS) {
    throw new TypeError(`groups must name at most ${MAX_PREVIEW_TOOLS} tools.`);
  }
  return groups;
}

const fetchBindingWorkbench = createServerFn({ method: "GET" })
  .validator(
    (input: {
      readonly preflightModels: boolean;
      readonly request: WorkbenchRequest;
      readonly scope: EnvironmentScope;
    }) => ({
      ...scopedInput(input),
      preflightModels: fields(input).preflightModels === true,
      request: workbenchRequest(fields(input).request),
    }),
  )
  .handler(async ({ data }) =>
    loadBindingWorkbench(
      await requireAccessToken(),
      data.scope,
      data.request,
      data.preflightModels,
    ),
  );

/** Posted because a preview can name 256 tools, too many for a query string. */
const fetchBindingPreview = createServerFn({ method: "POST" })
  .validator(
    (input: { readonly groups: readonly PreviewGroup[]; readonly scope: EnvironmentScope }) => ({
      ...scopedInput(input),
      groups: previewGroups(fields(input).groups),
    }),
  )
  .handler(async ({ data }) =>
    loadBindingPreview(await requireAccessToken(), data.scope, data.groups),
  );

/**
 * The editor's server read, under the agent's key so every agent mutation refreshes it. It is
 * read fresh on each visit because a stale base would turn a save into a conflict.
 */
export const bindingWorkbenchQuery = (
  scope: EnvironmentScope,
  request: WorkbenchRequest,
  preflightModels: boolean,
) =>
  queryOptions({
    queryFn: () => fetchBindingWorkbench({ data: { preflightModels, request, scope } }),
    queryKey: [...agentKey(scope, request.definitionId), "bindings", request, preflightModels],
    staleTime: 0,
  });

export const bindingPreviewQuery = (
  scope: EnvironmentScope,
  definitionId: string,
  groups: readonly PreviewGroup[],
) =>
  queryOptions({
    enabled: groups.length > 0,
    queryFn: () => fetchBindingPreview({ data: { groups, scope } }),
    queryKey: [...agentKey(scope, definitionId), "binding-preview", groups],
  });
