import type {
  Brain,
  BrainDeploymentMount,
  BrainGrant,
  BrainHumanRole,
  BrainMachinePermission,
} from "./models.ts";

export type BrainOperation = "admin" | "read" | "write";

export interface HumanBrainCaller {
  readonly kind: "human";
  readonly membershipActive: boolean;
  readonly organizationRole: "admin" | "billing" | "member" | "owner" | "viewer";
  readonly principalActive: boolean;
  readonly principalId: string;
  readonly scopes: readonly string[];
}

export interface ServiceBrainCaller {
  readonly credentialActive: boolean;
  readonly environmentId: string;
  readonly kind: "service";
  readonly organizationId: string;
  readonly projectId: string;
  readonly scopes: readonly string[];
  readonly serviceAccountActive: boolean;
  readonly serviceAccountId: string;
}

export type BrainCaller = HumanBrainCaller | ServiceBrainCaller;

export interface AgentBrainAccess {
  readonly agentDefinitionGrant?: BrainGrant;
  readonly agentDefinitionId: string;
  readonly deploymentId: string;
  readonly mount?: BrainDeploymentMount;
  readonly releasePermission: BrainMachinePermission;
}

export interface BrainAuthorizationInput {
  readonly agent?: AgentBrainAccess;
  readonly brain: Brain;
  readonly caller: BrainCaller;
  readonly callerGrant?: BrainGrant;
  readonly operation: BrainOperation;
  readonly ownerActive: boolean;
  readonly organizationActive: boolean;
}

export type BrainAuthorizationDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason:
        | "agent-grant-invalid"
        | "agent-mount-invalid"
        | "brain-inactive"
        | "caller-grant-invalid"
        | "caller-inactive"
        | "organization-inactive"
        | "owner-inactive"
        | "permission-denied"
        | "scope-denied"
        | "tenant-mismatch";
    };

function deny(reason: Exclude<BrainAuthorizationDecision, { readonly allowed: true }>["reason"]) {
  return { allowed: false as const, reason };
}

function humanPermissionAllows(permission: BrainHumanRole, operation: BrainOperation) {
  if (operation === "read") return true;
  if (operation === "write") return permission !== "reader";
  return permission === "owner";
}

function machinePermissionAllows(permission: BrainMachinePermission, operation: BrainOperation) {
  return operation === "read" || (operation === "write" && permission === "read-write");
}

function activeGrantForBrain(grant: BrainGrant | undefined, brain: Brain) {
  return (
    grant?.status === "active" &&
    grant.organizationId === brain.organizationId &&
    grant.brainId === brain.id &&
    grant.brainKind === brain.kind &&
    (brain.kind === "company" || grant.ownershipGeneration === brain.ownershipGeneration)
  );
}

function callerGrantMatches(caller: BrainCaller, grant: BrainGrant) {
  if (caller.kind === "human") {
    return (
      (grant.target.type === "principal" && grant.target.principalId === caller.principalId) ||
      (grant.target.type === "organization-role" &&
        grant.target.organizationRole === caller.organizationRole)
    );
  }
  return (
    grant.target.type === "service-account" &&
    grant.target.serviceAccountId === caller.serviceAccountId &&
    grant.target.projectId === caller.projectId &&
    grant.target.environmentId === caller.environmentId
  );
}

function callerPermissionAllows(caller: BrainCaller, grant: BrainGrant, operation: BrainOperation) {
  return caller.kind === "human"
    ? humanPermissionAllows(grant.permission as BrainHumanRole, operation)
    : machinePermissionAllows(grant.permission as BrainMachinePermission, operation);
}

function scopeAllows(caller: BrainCaller, operation: BrainOperation) {
  const required = operation === "read" ? "brains:read" : `brains:${operation}`;
  return (
    caller.scopes.includes(required) ||
    caller.scopes.includes("brains:*") ||
    caller.scopes.includes("platform:admin") ||
    caller.scopes.includes("platform:*")
  );
}

export function authorizeBrainAccess(input: BrainAuthorizationInput): BrainAuthorizationDecision {
  const { agent, brain, caller, callerGrant, operation } = input;
  if (!input.organizationActive) return deny("organization-inactive");
  if (brain.status !== "active") return deny("brain-inactive");
  if (caller.kind === "human") {
    if (!caller.principalActive || !caller.membershipActive) return deny("caller-inactive");
  } else if (!caller.serviceAccountActive || !caller.credentialActive) {
    return deny("caller-inactive");
  }
  if (caller.kind === "service" && caller.organizationId !== brain.organizationId) {
    return deny("tenant-mismatch");
  }
  if (!scopeAllows(caller, operation)) return deny("scope-denied");
  if (brain.kind === "member-private") {
    if (!brain.ownerPrincipalId || brain.ownershipGeneration <= 0 || !input.ownerActive) {
      return deny("owner-inactive");
    }
    if (caller.kind === "human" && caller.principalId !== brain.ownerPrincipalId) {
      return deny("permission-denied");
    }
  }
  if (!activeGrantForBrain(callerGrant, brain) || !callerGrantMatches(caller, callerGrant!)) {
    return deny("caller-grant-invalid");
  }
  if (!callerPermissionAllows(caller, callerGrant!, operation)) return deny("permission-denied");
  if (!agent) return { allowed: true };
  if (
    !activeGrantForBrain(agent.agentDefinitionGrant, brain) ||
    agent.agentDefinitionGrant!.target.type !== "agent-definition" ||
    agent.agentDefinitionGrant!.target.agentDefinitionId !== agent.agentDefinitionId
  ) {
    return deny("agent-grant-invalid");
  }
  const mount = agent.mount;
  const agentTarget = agent.agentDefinitionGrant!.target;
  if (
    !mount ||
    mount.status !== "active" ||
    mount.organizationId !== brain.organizationId ||
    mount.brainId !== brain.id ||
    mount.agentDefinitionId !== agent.agentDefinitionId ||
    mount.agentDeploymentId !== agent.deploymentId ||
    agentTarget.type !== "agent-definition" ||
    mount.projectId !== agentTarget.projectId ||
    mount.environmentId !== agentTarget.environmentId ||
    mount.brainKind !== brain.kind ||
    (brain.kind === "member-private" && mount.ownershipGeneration !== brain.ownershipGeneration)
  ) {
    return deny("agent-mount-invalid");
  }
  if (
    operation === "admin" ||
    !machinePermissionAllows(
      agent.agentDefinitionGrant!.permission as BrainMachinePermission,
      operation,
    ) ||
    !machinePermissionAllows(mount.permission, operation) ||
    !machinePermissionAllows(agent.releasePermission, operation)
  ) {
    return deny("permission-denied");
  }
  return { allowed: true };
}
