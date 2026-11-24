import {
  AgentToolAuthorizationBinding,
  AgentToolName,
} from "@deployments-ai/agent-manifest/schema";
import type { ToolPolicyEvaluation } from "@deployments-ai/api-contract/tool-catalog";
import type { ModelAdmissionFailureReason } from "@deployments-ai/model-gateway/model-policy";
import { Schema } from "effect";
import type { PlatformProblem } from "../errors.ts";
import type { ToolBinding, ToolBindingChanges } from "./runtime-config.ts";

type Action = "allow" | "deny" | "require_approval";
export type ToolEvaluation = typeof ToolPolicyEvaluation.Type;

/** The releases a deployment runs: the primary, plus the candidate while a canary runs. */
export type ReleaseRole = "primary" | "candidate";

/** How the runtime executes a tool, which decides the grants it can use. */
export type ToolRoute =
  | { readonly kind: "provider"; readonly providerKey: string }
  | { readonly kind: "mcp"; readonly mcpServerId: string }
  /** Builtin, client, and hosted-code tools: the runtime decides them without the binding. */
  | { readonly kind: "catalog" }
  /** No active definition has the name, so the runtime denies it. */
  | { readonly kind: "unregistered" };

/** A tool some target release declares with `authorization: "workspace"`. */
export interface WorkspaceTool {
  readonly name: string;
  readonly requiredIn: readonly ReleaseRole[];
  readonly bindableIn: readonly ReleaseRole[];
  readonly route: ToolRoute;
  /** The definition's scopes, which the runtime compares with the grant's. */
  readonly requiredScopes: readonly string[];
  readonly defaultPolicyAction?: Action;
}

export type BindingTarget =
  | {
      readonly kind: "new";
      readonly releaseId: string;
      readonly seed?: {
        readonly deploymentId: string;
        readonly version: number;
      };
    }
  | {
      readonly kind: "existing";
      readonly deploymentId: string;
      readonly version: number;
      readonly desiredState: "paused" | "running";
      readonly primaryReleaseId: string;
      readonly candidateReleaseId?: string;
    };

export interface GrantOption {
  readonly id: string;
  readonly connectionId: string;
  readonly externalAccountId: string;
  readonly providerKey: string;
  readonly purpose: string;
  readonly scopes: readonly string[];
  readonly status: "active" | "revoked";
  readonly workspaceId: string | null;
  readonly workspaceName?: string;
}

/** A known reason the save may be refused for something other than a tool binding. */
export type Preflight =
  | { readonly kind: "model_not_allowed"; readonly modelId: string }
  | {
      readonly kind: "sub_agent_unresolvable";
      readonly key: string;
      readonly deploymentId: string;
      readonly reason: "missing" | "stopped";
    };

/** One server read with everything the editor needs; manifests stay on the server. */
export interface BindingWorkbench {
  readonly target: BindingTarget;
  readonly tools: readonly WorkspaceTool[];
  readonly base: Readonly<Record<string, ToolBinding>>;
  readonly grants: readonly GrantOption[];
  /** `complete` is false when a capped list stopped early, so a miss is unknown. */
  readonly mcpConnections: {
    readonly complete: boolean;
    readonly items: readonly { readonly id: string; readonly active: boolean }[];
  };
  readonly policies: {
    readonly complete: boolean;
    readonly items: readonly { readonly id: string; readonly name: string }[];
  };
  readonly preflight: readonly Preflight[];
}

export type GrantProblem =
  | { readonly kind: "missing" }
  | { readonly kind: "revoked" }
  | { readonly kind: "wrong_purpose" }
  | { readonly kind: "wrong_provider"; readonly expected: string }
  | { readonly kind: "wrong_server"; readonly expected: string }
  | { readonly kind: "mcp_connection_inactive" }
  | { readonly kind: "missing_scopes"; readonly scopes: readonly string[] };

export type RowStatus =
  | { readonly kind: "ready" }
  | { readonly kind: "optional_unbound" }
  | { readonly kind: "binding_ignored" }
  | { readonly kind: "unregistered" }
  | { readonly kind: "not_bindable_in_canary" }
  | { readonly kind: "canary_conflict" }
  | { readonly kind: "needs_grant" }
  | { readonly kind: "grant_unusable"; readonly problem: GrantProblem }
  | { readonly kind: "policy_unusable" };

/** Statuses the API would refuse (`missing_tool_authorization`, `tool_authorization_not_allowed`). */
const BLOCKING: Record<RowStatus["kind"], boolean> = {
  binding_ignored: false,
  canary_conflict: true,
  grant_unusable: false,
  needs_grant: true,
  not_bindable_in_canary: false,
  optional_unbound: false,
  policy_unusable: false,
  ready: false,
  unregistered: false,
};

export function isBlocking(status: RowStatus) {
  return BLOCKING[status.kind];
}

export interface BindingRow {
  readonly tool: WorkspaceTool;
  readonly before?: ToolBinding;
  readonly after?: ToolBinding;
  readonly status: RowStatus;
  readonly eligible: readonly GrantOption[];
}

export interface BindingModel {
  readonly rows: readonly BindingRow[];
  /** Base bindings some target release cannot accept; the save removes them. */
  readonly dropped: readonly string[];
  /** What the browser sends: the tools whose binding differs from the base. */
  readonly changes: ToolBindingChanges;
  readonly submittable: boolean;
}

export function targetRoles(target: BindingTarget): readonly ReleaseRole[] {
  return target.kind === "existing" && target.candidateReleaseId
    ? ["primary", "candidate"]
    : ["primary"];
}

export function grantProblem(
  tool: WorkspaceTool,
  grant: GrantOption | undefined,
  workbench: Pick<BindingWorkbench, "mcpConnections">,
): GrantProblem | undefined {
  if (!grant) return { kind: "missing" };
  if (grant.status !== "active") return { kind: "revoked" };
  if (grant.purpose !== "agent-runtime") return { kind: "wrong_purpose" };
  const { route } = tool;
  if (route.kind === "provider" && grant.providerKey !== route.providerKey) {
    return { expected: route.providerKey, kind: "wrong_provider" };
  }
  if (route.kind === "mcp") {
    if (grant.providerKey !== "mcp" || grant.externalAccountId !== route.mcpServerId) {
      return { expected: route.mcpServerId, kind: "wrong_server" };
    }
    const connection = workbench.mcpConnections.items.find(({ id }) => id === grant.connectionId);
    if (connection ? !connection.active : workbench.mcpConnections.complete) {
      return { kind: "mcp_connection_inactive" };
    }
  }
  const missing = tool.requiredScopes.filter((scope) => !grant.scopes.includes(scope));
  return missing.length > 0 ? { kind: "missing_scopes", scopes: missing } : undefined;
}

export function eligibleGrants(tool: WorkspaceTool, workbench: BindingWorkbench) {
  return workbench.grants.filter((grant) => !grantProblem(tool, grant, workbench));
}

function rowStatus(
  tool: WorkspaceTool,
  after: ToolBinding | undefined,
  roles: readonly ReleaseRole[],
  workbench: BindingWorkbench,
): RowStatus {
  if (!roles.every((role) => tool.bindableIn.includes(role))) {
    return tool.requiredIn.length > 0
      ? { kind: "canary_conflict" }
      : { kind: "not_bindable_in_canary" };
  }
  if (!after) {
    return tool.requiredIn.length > 0 ? { kind: "needs_grant" } : { kind: "optional_unbound" };
  }
  if (tool.route.kind === "catalog") return { kind: "binding_ignored" };
  if (tool.route.kind === "unregistered") return { kind: "unregistered" };
  const grant = workbench.grants.find(({ id }) => id === after.authorizationId);
  const problem = grantProblem(tool, grant, workbench);
  if (problem) return { kind: "grant_unusable", problem };
  if (
    after.toolPolicyId &&
    workbench.policies.complete &&
    !workbench.policies.items.some(({ id }) => id === after.toolPolicyId)
  ) {
    return { kind: "policy_unusable" };
  }
  return { kind: "ready" };
}

/**
 * The editor's state: `choices` are deltas over the workbench's base, so after a conflict the
 * reloaded workbench rebases them and a choice that now equals the base drops out on its own.
 */
export function bindingModel(
  workbench: BindingWorkbench,
  choices: ToolBindingChanges,
): BindingModel {
  const roles = targetRoles(workbench.target);
  const bindable = new Set(
    workbench.tools
      .filter((tool) => roles.every((role) => tool.bindableIn.includes(role)))
      .map(({ name }) => name),
  );
  const changes: Record<string, ToolBinding | null> = {};
  const rows = workbench.tools.map((tool): BindingRow => {
    const before = workbench.base[tool.name];
    const choice = choices[tool.name];
    const after = !bindable.has(tool.name)
      ? undefined
      : choice === undefined
        ? before
        : (choice ?? undefined);
    if (
      bindable.has(tool.name) &&
      (before?.authorizationId !== after?.authorizationId ||
        before?.toolPolicyId !== after?.toolPolicyId)
    ) {
      changes[tool.name] = after ?? null;
    }
    return {
      eligible: eligibleGrants(tool, workbench),
      status: rowStatus(tool, after, roles, workbench),
      tool,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    };
  });
  const dropped = Object.keys(workbench.base).filter((tool) => !bindable.has(tool));
  return {
    changes,
    dropped,
    rows,
    submittable:
      !rows.some(({ status }) => isBlocking(status)) &&
      (workbench.target.kind === "new" || Object.keys(changes).length > 0 || dropped.length > 0),
  };
}

export const PREVIEW_CHUNK = 100;

/** Bound tools grouped per pinned policy, at most `PREVIEW_CHUNK` names per evaluation. */
export function previewGroups(model: BindingModel) {
  const byPolicy = Map.groupBy(
    model.rows.filter(
      (row) =>
        row.after?.toolPolicyId !== undefined &&
        (row.tool.route.kind === "provider" || row.tool.route.kind === "mcp"),
    ),
    (row) => row.after?.toolPolicyId ?? "",
  );
  return [...byPolicy].flatMap(([toolPolicyId, rows]) => {
    const names = rows.map(({ tool }) => tool.name).toSorted();
    return Array.from({ length: Math.ceil(names.length / PREVIEW_CHUNK) }, (_, index) => ({
      toolNames: names.slice(index * PREVIEW_CHUNK, (index + 1) * PREVIEW_CHUNK),
      toolPolicyId,
    }));
  });
}

export type RowPreview =
  | { readonly kind: "policy"; readonly evaluation: ToolEvaluation; readonly toolPolicyId: string }
  | { readonly kind: "tool_default"; readonly action: Action }
  | { readonly kind: "pending" }
  | {
      readonly kind: "not_applicable";
      readonly why: "unbound" | "binding_ignored" | "unregistered";
    };

/** What the runtime would decide for a row, given the policy evaluations loaded so far. */
export function rowPreview(
  row: BindingRow,
  evaluations: ReadonlyMap<string, ToolEvaluation>,
): RowPreview {
  if (!row.after) return { kind: "not_applicable", why: "unbound" };
  if (row.tool.route.kind === "catalog") return { kind: "not_applicable", why: "binding_ignored" };
  if (row.tool.route.kind === "unregistered") {
    return { kind: "not_applicable", why: "unregistered" };
  }
  if (!row.after.toolPolicyId) {
    return row.tool.defaultPolicyAction
      ? { action: row.tool.defaultPolicyAction, kind: "tool_default" }
      : { kind: "not_applicable", why: "unregistered" };
  }
  const evaluation = evaluations.get(`${row.after.toolPolicyId} ${row.tool.name}`);
  return evaluation
    ? { evaluation, kind: "policy", toolPolicyId: row.after.toolPolicyId }
    : { kind: "pending" };
}

/** At most one change per tool a manifest can declare. */
const MAX_CHANGES = 256;
const isToolName = Schema.is(AgentToolName);
const decodeBinding = Schema.decodeUnknownSync(Schema.NullOr(AgentToolAuthorizationBinding));

/**
 * Parses the browser's change set at the server-function boundary. Keys are checked one by one
 * because a schema record silently drops keys its key schema rejects.
 */
export function parseBindingChanges(input: unknown): ToolBindingChanges {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("changes must be an object.");
  }
  const entries = Object.entries(input);
  if (entries.length > MAX_CHANGES) {
    throw new TypeError(`changes must name at most ${MAX_CHANGES} tools.`);
  }
  return Object.fromEntries(
    entries.map(([tool, binding]) => {
      if (!isToolName(tool)) throw new TypeError("changes must be keyed by tool names.");
      return [tool, decodeBinding(binding)];
    }),
  );
}

const READMITS =
  "Deploying, resuming, or saving bindings on a running deployment re-admits the release's models.";

/** The two writes that admit a release's models: creating a deployment and saving its bindings. */
export type BindingsWrite = "deploy" | "save";

const MODEL_REMEDY: Record<ModelAdmissionFailureReason, (action: BindingsWrite) => string> = {
  invalid_model_id: () => "Publish a release whose model IDs are valid.",
  model_not_allowed_by_environment_policy: (action) =>
    action === "deploy"
      ? "A new deployment is admitted even when paused, so change the model policy, then deploy again."
      : "Change the model policy or pause the deployment, then save again.",
  model_not_in_catalog: () => "Publish a release whose models are active in the catalog.",
  unknown_model_provider: () =>
    "Publish a release whose model IDs start with a known provider prefix.",
};

const isModelRefusal = (code: string): code is ModelAdmissionFailureReason =>
  Object.hasOwn(MODEL_REMEDY, code);

/**
 * Names what refused a deploy or save when it was not the operator's tool binding change. The
 * server's message already shows as the problem's description.
 */
export function saveCause(problem: PlatformProblem, action: BindingsWrite): string | undefined {
  const code = problem.code ?? "";
  if (isModelRefusal(code)) return `${READMITS} ${MODEL_REMEDY[code](action)}`;
  switch (code) {
    case "idempotency_conflict":
      return "Check the deployments before trying again.";
    case "invalid_agent_deployment_config":
      return /^\/agentBindings/mu.test(problem.detail ?? problem.title)
        ? "Every save re-resolves the deployment's sub-agent bindings, and one no longer resolves. Rebind the sub-agent by updating the deployment's runtime configuration through the API, then save again."
        : "The release does not accept these tool bindings.";
    default:
      return undefined;
  }
}
