import {
  MAX_AGENT_DELEGATION_DEPTH,
  type AgentSubAgent,
  type AgentSubAgentBinding,
} from "@deployments-ai/agent-manifest";
import {
  RuntimeDeploymentRequiredError,
  RuntimeToolPreparationRetryableError,
  requireAgentDeploymentId,
} from "@deployments-ai/agent-runtime";
import {
  key,
  makeConversationPersistence,
  type DynamoDatabaseService,
  type PlatformRecord,
  type Ulid,
  workerPersistence,
} from "@deployments-ai/db";
import type { ExecuteRuntimeBuiltinTool } from "./runtime-tools.ts";

type DelegationRequest = Parameters<ExecuteRuntimeBuiltinTool>[0];
type Deployment = Extract<PlatformRecord, { readonly itemType: "agent-deployment" }>;
type Release = Extract<PlatformRecord, { readonly itemType: "agent-release" }>;
export type RunDelegation = Extract<PlatformRecord, { readonly itemType: "run-delegation" }>;

export interface DeclaredDelegation {
  readonly agents: readonly AgentSubAgent[];
  readonly bindings: Readonly<Record<string, AgentSubAgentBinding>>;
}

export interface DeclaredDelegationTarget {
  readonly agent: AgentSubAgent;
  readonly agentDeploymentId: string;
  readonly awaitResult: boolean;
  readonly edgeKind: "delegation" | "handoff";
}

export async function retryableDatabaseRead<Value>(
  request: Pick<DelegationRequest, "toolName">,
  read: () => Promise<Value>,
) {
  try {
    return await read();
  } catch (cause) {
    if (cause instanceof RuntimeToolPreparationRetryableError) throw cause;
    throw new RuntimeToolPreparationRetryableError(request.toolName, cause);
  }
}

async function environmentControlRecord(
  database: DynamoDatabaseService,
  request: DelegationRequest,
  itemType: "agent-deployment" | "agent-release",
  id: string,
) {
  return await retryableDatabaseRead(request, () =>
    workerPersistence.read(
      database,
      "control",
      {
        pk: key("ORG", request.organizationId, "ENV", request.environmentId),
        sk: key(itemType.toUpperCase(), id),
      },
      true,
    ),
  );
}

function inScope(record: Deployment | Release, request: DelegationRequest) {
  return (
    record.data.organizationId === request.organizationId &&
    record.data.projectId === request.projectId &&
    record.data.environmentId === request.environmentId
  );
}

/**
 * Loads the calling release's declared sub-agents and the calling deployment's bindings. Returns
 * undefined when the release declares none, preserving free-form delegation.
 */
export async function loadDeclaredDelegation(
  database: DynamoDatabaseService,
  request: DelegationRequest,
): Promise<DeclaredDelegation | undefined> {
  const agentDeploymentId = requireAgentDeploymentId(request, "Agent delegation");
  if (request.agentReleaseId === undefined) {
    throw new RuntimeDeploymentRequiredError("Agent delegation");
  }
  const release = await environmentControlRecord(
    database,
    request,
    "agent-release",
    request.agentReleaseId,
  );
  if (release?.itemType !== "agent-release" || !inScope(release, request)) {
    throw new TypeError("The calling agent release could not be loaded for delegation.");
  }
  const agents = release.data.manifest.spec.agents ?? [];
  if (agents.length === 0) return undefined;
  const deployment = await environmentControlRecord(
    database,
    request,
    "agent-deployment",
    agentDeploymentId,
  );
  if (deployment?.itemType !== "agent-deployment" || !inScope(deployment, request)) {
    throw new TypeError("The calling agent deployment could not be loaded for delegation.");
  }
  return { agents, bindings: deployment.data.runtimeConfig?.agentBindings ?? {} };
}

/** Accepts a declared sub-agent key or the deployment ID bound to one; nothing else. */
export function selectDeclaredTarget(
  declared: DeclaredDelegation,
  targetAgentId: string,
  requestedEdgeKind: string | undefined,
): DeclaredDelegationTarget {
  const byKey = declared.agents.find((agent) => agent.key === targetAgentId);
  const agent =
    byKey ??
    declared.agents.find(
      (candidate) =>
        Object.hasOwn(declared.bindings, candidate.key) &&
        declared.bindings[candidate.key]!.agentDeploymentId === targetAgentId,
    );
  if (!agent) {
    throw new TypeError(
      `Target ${targetAgentId} is not a declared sub-agent; use one of: ${declared.agents
        .map((candidate) => candidate.key)
        .join(", ")}.`,
    );
  }
  if (!Object.hasOwn(declared.bindings, agent.key)) {
    throw new TypeError(`Sub-agent ${agent.key} is not bound in this deployment.`);
  }
  const edgeKind = agent.edgeKind ?? "delegation";
  if (requestedEdgeKind !== undefined && requestedEdgeKind !== edgeKind) {
    throw new TypeError(`Sub-agent ${agent.key} is declared with edgeKind ${edgeKind}.`);
  }
  return {
    agent,
    agentDeploymentId: declared.bindings[agent.key]!.agentDeploymentId,
    awaitResult: agent.awaitResult === true,
    edgeKind,
  };
}

export async function loadRunDelegation(
  database: DynamoDatabaseService,
  organizationId: Ulid,
  childRunId: Ulid,
): Promise<RunDelegation | undefined> {
  const value = await makeConversationPersistence(database).get({
    childRunId,
    kind: "run-delegation",
    organizationId,
  });
  if (value === undefined) return undefined;
  if (
    value.itemType !== "run-delegation" ||
    value.data.childRunId !== childRunId ||
    value.data.organizationId !== organizationId
  ) {
    throw new TypeError(`Delegation link for run ${childRunId} does not match its key.`);
  }
  return value;
}

/**
 * Enforces the declared target's agent key, the maximum delegation depth, and cycle refusal along
 * the delegation chain from the root run through the calling run.
 */
export async function assertDeclaredDelegationAllowed(
  database: DynamoDatabaseService,
  request: DelegationRequest,
  selection: DeclaredDelegationTarget,
  target: Deployment,
): Promise<void> {
  const [release, link] = await Promise.all([
    environmentControlRecord(database, request, "agent-release", target.data.agentReleaseId),
    retryableDatabaseRead(request, () =>
      loadRunDelegation(database, request.organizationId, request.runId),
    ),
  ]);
  if (
    release?.itemType !== "agent-release" ||
    !inScope(release, request) ||
    release.data.manifest.metadata.key !== selection.agent.agentKey
  ) {
    throw new TypeError(
      `Sub-agent ${selection.agent.key} is bound to a deployment that does not run agent ${selection.agent.agentKey}.`,
    );
  }
  if (
    link &&
    (link.data.projectId !== request.projectId || link.data.environmentId !== request.environmentId)
  ) {
    throw new TypeError("The calling run's delegation link does not match its scope.");
  }
  const depth = (link?.data.depth ?? 0) + 1;
  if (depth > MAX_AGENT_DELEGATION_DEPTH) {
    throw new TypeError(
      `Delegation depth would exceed the maximum of ${MAX_AGENT_DELEGATION_DEPTH} sub-agent levels.`,
    );
  }
  const chain = [...(link?.data.ancestorAgentDeploymentIds ?? []), request.agentDeploymentId];
  if (chain.includes(target.data.id)) {
    throw new TypeError(
      `Sub-agent ${selection.agent.key} is already part of this delegation chain; cycles are refused.`,
    );
  }
}
