import "@tanstack/react-start/server-only";
import { notFound } from "@tanstack/react-router";
import type { ToolBinding } from "../agents/runtime-config.ts";
import {
  targetRoles,
  type BindingTarget,
  type BindingWorkbench,
  type GrantOption,
  type Preflight,
  type ReleaseRole,
  type ToolEvaluation,
  type ToolRoute,
  type WorkspaceTool,
} from "../agents/tool-bindings.ts";
import { PlatformApiError, type PlatformProblem } from "../errors.ts";
import type { EnvironmentScope } from "../scope.ts";
import { loadConnectionGrants } from "./agent-runtime-data.ts";
import { loadWorkspaces } from "./connection-data.ts";
import { requirePublicIds } from "./console-data.ts";
import { fanOut } from "./fan-out.ts";
import { callRoute, type RouteResponse } from "./platform-api.ts";
import { loadReleaseFacts, type ReleaseFacts } from "./release-facts.ts";
import { decodeRequestBody } from "./request-body.ts";
import { deploymentOf } from "./tool-binding-actions.ts";
import { loadPolicyOptions } from "./tool-policy-data.ts";
import {
  extensionSummary,
  loadExtensionDirectory,
  loadMcpDirectory,
  type ExtensionDirectory,
  type ExtensionSummary,
} from "./tool-directory.ts";

const PAGE_LIMIT = 100;
const MAX_MODEL_SEARCH_LENGTH = 100;

export type WorkbenchRequest =
  | {
      readonly kind: "edit";
      readonly definitionId: string;
      readonly deploymentId: string;
    }
  | {
      readonly kind: "deploy";
      readonly definitionId: string;
      readonly releaseId: string;
      readonly seedDeploymentId?: string;
    };

async function targetOf(accessToken: string, scope: EnvironmentScope, request: WorkbenchRequest) {
  if (request.kind === "edit") {
    const deployment = await deploymentOf(
      callRoute,
      accessToken,
      scope,
      request.definitionId,
      request.deploymentId,
    );
    const target: BindingTarget = {
      deploymentId: deployment.id,
      desiredState: deployment.desiredState === "running" ? "running" : "paused",
      kind: "existing",
      primaryReleaseId: deployment.agentReleaseId,
      version: deployment.version,
      ...(deployment.candidateAgentReleaseId
        ? { candidateReleaseId: deployment.candidateAgentReleaseId }
        : {}),
    };
    return { base: deployment.runtimeConfig, target };
  }
  const seed = request.seedDeploymentId
    ? await deploymentOf(
        callRoute,
        accessToken,
        scope,
        request.definitionId,
        request.seedDeploymentId,
      )
    : undefined;
  const target: BindingTarget = {
    kind: "new",
    releaseId: request.releaseId,
    ...(seed ? { seed: { deploymentId: seed.id, version: seed.version } } : {}),
  };
  return { base: seed?.runtimeConfig, target };
}

/** Each role's release facts; a release of another definition is not this page's to show. */
async function releasesOf(
  accessToken: string,
  scope: EnvironmentScope,
  definitionId: string,
  target: BindingTarget,
) {
  const ids: Record<ReleaseRole, string | undefined> =
    target.kind === "new"
      ? { candidate: undefined, primary: target.releaseId }
      : {
          candidate: target.candidateReleaseId,
          primary: target.primaryReleaseId,
        };
  const roles = targetRoles(target);
  const lookup = await loadReleaseFacts(
    accessToken,
    scope,
    roles.flatMap((role) => ids[role] ?? []),
  );
  return roles.map((role) => {
    const facts = lookup.get(ids[role] ?? "");
    if (!facts) throw notFound();
    if ("problem" in facts) throw new PlatformApiError("getAgentRelease", facts.problem);
    if (facts.agentDefinitionId !== definitionId) throw notFound();
    return { facts, role };
  });
}

function extensionRoute(extension: ExtensionSummary): ToolRoute {
  switch (extension.execution.type) {
    case "mcp":
      return { kind: "mcp", mcpServerId: extension.execution.mcpServerId };
    case "vendor_mcp":
      return { kind: "provider", providerKey: extension.execution.providerKey };
    case "http_callback":
      return extension.providerKey
        ? { kind: "provider", providerKey: extension.providerKey }
        : { kind: "unregistered" };
    case "client":
    case "hosted_code":
      return { kind: "catalog" };
    default: {
      const unexpected: never = extension.execution;
      return unexpected;
    }
  }
}

type ToolDefinition = Pick<WorkspaceTool, "defaultPolicyAction" | "requiredScopes" | "route">;

type CatalogTool = Pick<
  RouteResponse<"getTool">,
  "defaultPolicyAction" | "policyBinding" | "providerKey" | "requiredScopes" | "status"
>;

export interface ToolLookup {
  readonly catalog: (toolName: string) => Promise<CatalogTool | undefined>;
  readonly extension: (toolName: string) => Promise<ExtensionSummary | undefined>;
}

function catalogRoute(tool: CatalogTool): ToolRoute {
  if (tool.policyBinding === "catalog") return { kind: "catalog" };
  return tool.policyBinding === "connection" && tool.providerKey
    ? { kind: "provider", providerKey: tool.providerKey }
    : { kind: "unregistered" };
}

/**
 * How the runtime would execute each tool: an active tenant extension of that name first, then
 * the platform catalog. A name the capped extension directory does not list as active is read
 * directly, since an archived entry of that name does not rule out an active one past the cap.
 */
export async function toolDefinitions(
  names: readonly string[],
  directory: ExtensionDirectory,
  lookup: ToolLookup,
): Promise<ReadonlyMap<string, ToolDefinition>> {
  const active = new Map(
    directory.extensions
      .filter(({ status }) => status === "active")
      .map((extension) => [extension.name, extension]),
  );
  const resolved = await fanOut(
    names,
    async (name): Promise<readonly [string, ToolDefinition] | undefined> => {
      const extension =
        active.get(name) ?? (directory.complete ? undefined : await lookup.extension(name));
      if (extension?.status === "active") {
        return [
          name,
          {
            defaultPolicyAction: extension.defaultPolicyAction,
            requiredScopes: extension.requiredScopes,
            route: extensionRoute(extension),
          },
        ];
      }
      const tool = await lookup.catalog(name);
      return tool?.status === "active"
        ? [
            name,
            {
              defaultPolicyAction: tool.defaultPolicyAction,
              requiredScopes: tool.requiredScopes,
              route: catalogRoute(tool),
            },
          ]
        : undefined;
    },
  );
  return new Map(resolved.filter((entry) => entry !== undefined));
}

async function unlessNotFound<Result>(request: Promise<Result>) {
  try {
    return await request;
  } catch (error) {
    if (error instanceof PlatformApiError && error.problem.status === 404) return undefined;
    throw error;
  }
}

function workspaceTools(
  releases: readonly {
    readonly facts: ReleaseFacts;
    readonly role: ReleaseRole;
  }[],
  definitions: ReadonlyMap<string, ToolDefinition>,
): WorkspaceTool[] {
  const names = [
    ...new Set(releases.flatMap(({ facts }) => facts.workspaceTools.map(({ name }) => name))),
  ].toSorted();
  return names.map((name) => {
    const declared = releases.flatMap(({ facts, role }) =>
      facts.workspaceTools.filter((tool) => tool.name === name).map((tool) => ({ role, tool })),
    );
    const definition = definitions.get(name);
    return {
      bindableIn: declared.map(({ role }) => role),
      name,
      requiredIn: declared.filter(({ tool }) => tool.required).map(({ role }) => role),
      requiredScopes: definition?.requiredScopes ?? [],
      route: definition?.route ?? { kind: "unregistered" },
      ...(definition?.defaultPolicyAction
        ? { defaultPolicyAction: definition.defaultPolicyAction }
        : {}),
    };
  });
}

/** Sub-agent deployments that would make the save fail regardless of tool bindings. */
async function subAgentPreflight(
  accessToken: string,
  scope: EnvironmentScope,
  bindings: Readonly<Record<string, { readonly agentDeploymentId: string }>>,
): Promise<Preflight[]> {
  const checks = await fanOut(Object.values(bindings), async ({ agentDeploymentId }) => {
    try {
      const bound = await callRoute(
        "getAgentDeployment",
        { path: { id: agentDeploymentId }, scope },
        accessToken,
      );
      return bound.desiredState === "stopped" ? ("stopped" as const) : undefined;
    } catch (error) {
      if (error instanceof PlatformApiError && error.problem.status === 404)
        return "missing" as const;
      throw error;
    }
  });
  return Object.entries(bindings).flatMap(([key, { agentDeploymentId }], index) => {
    const reason = checks[index];
    return reason
      ? [
          {
            deploymentId: agentDeploymentId,
            key,
            kind: "sub_agent_unresolvable" as const,
            reason,
          },
        ]
      : [];
  });
}

/** Models the catalog lists as not allowed; aliases and operator grants are left to the API. */
async function modelPreflight(
  accessToken: string,
  scope: EnvironmentScope,
  releases: readonly { readonly facts: ReleaseFacts }[],
): Promise<Preflight[]> {
  const modelIds = [
    ...new Set(releases.flatMap(({ facts }) => [facts.models.primary, ...facts.models.fallbacks])),
  ].filter((modelId) => modelId.length <= MAX_MODEL_SEARCH_LENGTH);
  const pages = await fanOut(modelIds, (search) =>
    callRoute("listModels", { query: { limit: PAGE_LIMIT, search }, scope }, accessToken),
  );
  return modelIds.flatMap((modelId, index) =>
    pages[index]?.items.some((item) => item.modelId === modelId && !item.allowed)
      ? [{ kind: "model_not_allowed" as const, modelId }]
      : [],
  );
}

function grantOptions(
  grants: readonly RouteResponse<"listConnectionGrants">["items"][number][],
  workspaces: ReadonlyMap<string, string>,
  pinned: ReadonlySet<string>,
): GrantOption[] {
  return grants
    .filter(
      (grant) =>
        pinned.has(grant.id) || (grant.status === "active" && grant.purpose === "agent-runtime"),
    )
    .map((grant) => {
      const workspaceName =
        grant.workspaceId === null ? undefined : workspaces.get(grant.workspaceId);
      return {
        connectionId: grant.connectionId,
        externalAccountId: grant.externalAccountId,
        id: grant.id,
        providerKey: grant.providerKey,
        purpose: grant.purpose,
        scopes: grant.scopes,
        status: grant.status,
        workspaceId: grant.workspaceId,
        ...(workspaceName ? { workspaceName } : {}),
      };
    });
}

/**
 * Everything the bindings editor needs in one projected read: the target's releases, how each
 * workspace tool would run, the grants and policies it can pin, and what else could refuse the
 * save. Model preflight runs only when the save re-admits models: a deploy, or a running
 * deployment.
 */
export async function loadBindingWorkbench(
  accessToken: string,
  scope: EnvironmentScope,
  request: WorkbenchRequest,
  preflightModels: boolean,
): Promise<BindingWorkbench> {
  requirePublicIds({
    ...scope,
    definitionId: request.definitionId,
    ...(request.kind === "edit"
      ? { deploymentId: request.deploymentId }
      : {
          releaseId: request.releaseId,
          ...(request.seedDeploymentId ? { seed: request.seedDeploymentId } : {}),
        }),
  });
  const { base, target } = await targetOf(accessToken, scope, request);
  const releases = await releasesOf(accessToken, scope, request.definitionId, target);
  const [extensions, mcp, grants, policies, workspaces] = await Promise.all([
    loadExtensionDirectory(accessToken, scope),
    loadMcpDirectory(accessToken, scope),
    loadConnectionGrants(accessToken, scope),
    loadPolicyOptions(accessToken, scope),
    loadWorkspaces(accessToken, scope),
  ]);
  const names = [
    ...new Set(releases.flatMap(({ facts }) => facts.workspaceTools.map(({ name }) => name))),
  ];
  const definitions = await toolDefinitions(names, extensions, {
    catalog: (toolName) =>
      unlessNotFound(callRoute("getTool", { path: { toolName }, scope }, accessToken)),
    extension: async (toolName) => {
      const tool = await unlessNotFound(
        callRoute("getExtensionTool", { path: { toolName }, scope }, accessToken),
      );
      return tool && extensionSummary(tool);
    },
  });
  const reAdmits = target.kind === "new" || target.desiredState === "running";
  const preflight = [
    ...(await subAgentPreflight(accessToken, scope, base?.agentBindings ?? {})),
    ...(preflightModels && reAdmits ? await modelPreflight(accessToken, scope, releases) : []),
  ];
  const bindings: Readonly<Record<string, ToolBinding>> = base?.toolAuthorizations ?? {};
  return {
    base: bindings,
    grants: grantOptions(
      grants,
      new Map(workspaces.map(({ id, name }) => [id, name])),
      new Set(Object.values(bindings).map(({ authorizationId }) => authorizationId)),
    ),
    mcpConnections: {
      complete: mcp.complete,
      items: mcp.connections.map(({ id, status }) => ({ active: status === "active", id })),
    },
    policies,
    preflight,
    target,
    tools: workspaceTools(releases, definitions),
  };
}

/** One pinned policy's evaluation of its bound tools, or the problem it returned. */
export type PolicyPreview =
  | {
      readonly results: readonly ToolEvaluation[];
      readonly toolPolicyId: string;
    }
  | { readonly problem: PlatformProblem; readonly toolPolicyId: string };

/**
 * Evaluates bound tools against their pinned policy through the policy form, which assumes the
 * grant carries the tool's required scopes; the deployment form after saving is authoritative.
 */
export function loadBindingPreview(
  accessToken: string,
  scope: EnvironmentScope,
  groups: readonly {
    readonly toolNames: readonly string[];
    readonly toolPolicyId: string;
  }[],
): Promise<PolicyPreview[]> {
  return fanOut(groups, async ({ toolNames, toolPolicyId }) => {
    try {
      const { results } = await callRoute(
        "evaluateToolPolicy",
        {
          body: decodeRequestBody("evaluateToolPolicy", "EvaluateToolPolicyRequest", {
            toolNames,
            toolPolicyId,
          }),
          scope,
        },
        accessToken,
      );
      return { results, toolPolicyId };
    } catch (error) {
      if (error instanceof PlatformApiError) return { problem: error.problem, toolPolicyId };
      throw error;
    }
  });
}
