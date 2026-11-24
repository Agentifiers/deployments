import {
  authorizeBrainAccess,
  type Brain,
  type BrainAuthorizationInput,
  type BrainGrant,
  type BrainRepository,
} from "@deployments-ai/brains";
import {
  canHoldBrainRoleGrant,
  executionBindingIsActive,
  key,
  makeExecutionBindingPersistence,
  makeOrganizationHoldReader,
  type DynamoDatabaseService,
  type PlatformRecord,
  workerPersistence,
} from "@deployments-ai/db";
import { admitConsistently } from "@deployments-ai/organization-admission";
import { loadThreadRunById } from "../record-readers.ts";
import type { ExecuteRuntimeBuiltinTool } from "../runtime-tools.ts";
import type { RunRecordValue } from "../types.ts";

export type BrainToolRequest = Parameters<ExecuteRuntimeBuiltinTool>[0];
type CustomerBrainToolRequest = Extract<
  BrainToolRequest,
  { readonly executionBindingId?: undefined }
>;
type BoundBrainToolRequest = Extract<BrainToolRequest, { readonly executionBindingId: string }>;
type ControlRecord<ItemType extends PlatformRecord["itemType"]> = Extract<
  PlatformRecord,
  { readonly itemType: ItemType }
>;

interface BrainToolAuthorizationInput {
  readonly brain: Brain;
  readonly database: DynamoDatabaseService;
  readonly repository: BrainRepository;
  readonly request: BrainToolRequest;
}

/**
 * The deployment whose agent-definition grant and Brain mount authorize a run. Customer runs act
 * as their own deployment; preview runs act as their binding's source deployment.
 */
interface BrainAgentSubject {
  readonly agentDefinitionId: string;
  readonly agentDeploymentId: string;
  readonly definition: ControlRecord<"agent-definition">;
  readonly deployment: ControlRecord<"agent-deployment">;
  /** Only customer runs carry a release; Brain writes are attributed to it. */
  readonly release?: ControlRecord<"agent-release">;
}

export function denyBrainAccess(): never {
  throw new TypeError("Brain access is not authorized for this run.");
}

async function getControlRecord(
  database: DynamoDatabaseService,
  recordKey: { readonly pk: string; readonly sk: string },
) {
  return await workerPersistence.read(database, "control", recordKey, true);
}

/** In-run Brain access lives and dies with the run: a payment hold drains, a stopping hold ends it. */
async function organizationLetsRunContinue(database: DynamoDatabaseService, run: RunRecordValue) {
  const { decision } = await admitConsistently({
    activity: "run.continue",
    organizationId: run.data.organizationId,
    standing: makeOrganizationHoldReader(database),
  });
  return decision.kind;
}

function expected<ItemType extends PlatformRecord["itemType"]>(
  value: PlatformRecord | undefined,
  itemType: ItemType,
): ControlRecord<ItemType> {
  return value?.itemType === itemType ? (value as ControlRecord<ItemType>) : denyBrainAccess();
}

function scopeAllows(scopes: readonly string[], required: "brains:read" | "brains:write") {
  const group = required.split(":", 1)[0];
  return (
    scopes.includes("platform:*") ||
    scopes.includes("platform:admin") ||
    scopes.includes("brains:*") ||
    scopes.includes(`${group}:*`) ||
    scopes.includes(required)
  );
}

function serviceScopes(
  credential: ControlRecord<"api-credential">,
  serviceAccount: ControlRecord<"service-account">,
  operation: "read" | "write",
) {
  const required = `brains:${operation}` as const;
  return scopeAllows(credential.data.scopes, required) &&
    scopeAllows(serviceAccount.data.scopes, required)
    ? [required]
    : [];
}

async function ownerActive(database: DynamoDatabaseService, brain: Brain): Promise<boolean> {
  if (brain.kind === "company") return true;
  if (!brain.ownerPrincipalId) return false;
  const [principal, member] = await Promise.all([
    getControlRecord(database, {
      pk: key("PRINCIPAL", brain.ownerPrincipalId),
      sk: key("PRINCIPAL", brain.ownerPrincipalId),
    }),
    getControlRecord(database, {
      pk: key("ORG", brain.organizationId),
      sk: key("ORGANIZATION-MEMBER", brain.ownerPrincipalId),
    }),
  ]);
  return (
    principal?.itemType === "principal" &&
    principal.data.kind === "human" &&
    principal.data.status === "active" &&
    member?.itemType === "organization-member" &&
    member.data.status === "active"
  );
}

async function customerSubject(
  database: DynamoDatabaseService,
  request: CustomerBrainToolRequest,
  run: RunRecordValue,
): Promise<BrainAgentSubject> {
  if (
    run.data.agentDeploymentId !== request.agentDeploymentId ||
    run.data.agentReleaseId !== request.agentReleaseId
  ) {
    return denyBrainAccess();
  }
  const partition = key("ORG", request.organizationId, "ENV", request.environmentId);
  const [definitionValue, deploymentValue, releaseValue] = await Promise.all([
    getControlRecord(database, {
      pk: partition,
      sk: key("AGENT-DEFINITION", request.agentDefinitionId),
    }),
    getControlRecord(database, {
      pk: partition,
      sk: key("AGENT-DEPLOYMENT", request.agentDeploymentId),
    }),
    getControlRecord(database, {
      pk: partition,
      sk: key("AGENT-RELEASE", request.agentReleaseId),
    }),
  ]);
  const definition = expected(definitionValue, "agent-definition");
  const deployment = expected(deploymentValue, "agent-deployment");
  const release = expected(releaseValue, "agent-release");
  if (
    definition.data.id !== request.agentDefinitionId ||
    deployment.data.currentState !== "ready" ||
    deployment.data.desiredState !== "running" ||
    deployment.data.agentDefinitionId !== request.agentDefinitionId ||
    release.data.status !== "active" ||
    release.data.agentDefinitionId !== request.agentDefinitionId ||
    !release.data.manifest.spec.capabilities?.tools.some(
      (candidate) => candidate.name === request.toolName,
    )
  ) {
    return denyBrainAccess();
  }
  return {
    agentDefinitionId: request.agentDefinitionId,
    agentDeploymentId: request.agentDeploymentId,
    definition,
    deployment,
    release,
  };
}

/**
 * Preview runs read Brains as the deployment their binding snapshotted through
 * `runtimeConfigFromAgentDeploymentId`: that deployment's agent-definition grant and mount apply
 * exactly as they would to the deployment itself, so a preview never sees more than production.
 * Evaluation runs and previews without a source deployment have no Brain access, keeping
 * evaluation scores independent of mutable Brain content.
 */
async function previewSubject(
  database: DynamoDatabaseService,
  request: BoundBrainToolRequest,
  run: RunRecordValue,
): Promise<BrainAgentSubject> {
  if (
    request.executionPurpose !== "preview" ||
    run.data.executionBindingId !== request.executionBindingId ||
    run.data.executionPurpose !== "preview" ||
    run.data.agentReleaseId !== request.agentReleaseId
  ) {
    return denyBrainAccess();
  }
  const binding = await makeExecutionBindingPersistence(database).get({
    environmentId: request.environmentId,
    executionBindingId: request.executionBindingId,
    organizationId: request.organizationId,
  });
  const agentDeploymentId = binding?.data.runtimeConfigSourceAgentDeploymentId;
  if (
    !binding ||
    agentDeploymentId === undefined ||
    binding.data.projectId !== request.projectId ||
    binding.data.purpose !== "preview" ||
    !executionBindingIsActive(binding, new Date()) ||
    !binding.data.manifest.spec.capabilities?.tools.some(
      (candidate) => candidate.name === request.toolName,
    )
  ) {
    return denyBrainAccess();
  }
  const partition = key("ORG", request.organizationId, "ENV", request.environmentId);
  const deployment = expected(
    await getControlRecord(database, {
      pk: partition,
      sk: key("AGENT-DEPLOYMENT", agentDeploymentId),
    }),
    "agent-deployment",
  );
  const agentDefinitionId = deployment.data.agentDefinitionId;
  if (
    deployment.data.organizationId !== request.organizationId ||
    deployment.data.projectId !== request.projectId ||
    deployment.data.environmentId !== request.environmentId ||
    (binding.data.source.type === "release" &&
      binding.data.source.agentDefinitionId !== agentDefinitionId)
  ) {
    return denyBrainAccess();
  }
  const definition = expected(
    await getControlRecord(database, {
      pk: partition,
      sk: key("AGENT-DEFINITION", agentDefinitionId),
    }),
    "agent-definition",
  );
  if (definition.data.id !== agentDefinitionId) return denyBrainAccess();
  return { agentDefinitionId, agentDeploymentId, definition, deployment };
}

async function authorizeRunBrainAccess(
  input: BrainToolAuthorizationInput & { readonly operation: "read" | "write" },
) {
  const { brain, database, operation, repository, request } = input;
  const run = await loadThreadRunById(database, request, request.runId);
  if (
    !run ||
    run.data.status !== "running" ||
    run.data.organizationId !== request.organizationId ||
    run.data.projectId !== request.projectId ||
    run.data.environmentId !== request.environmentId ||
    run.data.workspaceId !== request.workspaceId
  ) {
    return denyBrainAccess();
  }
  const [organizationValue, subject] = await Promise.all([
    getControlRecord(database, {
      pk: key("ORG", request.organizationId),
      sk: key("ORG", request.organizationId),
    }),
    request.executionBindingId === undefined
      ? customerSubject(database, request, run)
      : // Brain writes stay denied for every bound run; only preview reads are authorized.
        operation === "read"
        ? previewSubject(database, request, run)
        : denyBrainAccess(),
  ]);
  const organization = expected(organizationValue, "organization");
  if (
    organization.data.status !== "active" ||
    subject.definition.data.status !== "active" ||
    subject.definition.data.workspaceId !== request.workspaceId
  ) {
    return denyBrainAccess();
  }
  const [agentDefinitionGrant, mount] = await Promise.all([
    repository.findActiveGrant(brain.organizationId, brain.id, {
      agentDefinitionId: subject.agentDefinitionId,
      environmentId: request.environmentId,
      projectId: request.projectId,
      type: "agent-definition",
    }),
    repository.findActiveMount(brain.organizationId, brain.id, subject.agentDeploymentId),
  ]);
  const agent = {
    ...(agentDefinitionGrant ? { agentDefinitionGrant } : {}),
    agentDefinitionId: subject.agentDefinitionId,
    deploymentId: subject.agentDeploymentId,
    ...(mount ? { mount } : {}),
    releasePermission: operation === "write" ? ("read-write" as const) : ("read" as const),
  };
  const shared = {
    agent,
    brain,
    operation,
    organizationActive: (await organizationLetsRunContinue(database, run)) === "admitted",
    ownerActive: await ownerActive(database, brain),
  } satisfies Omit<BrainAuthorizationInput, "caller" | "callerGrant">;
  const initiator = run.data.initiatingCaller;
  if (!initiator || initiator.type === "ingress") return denyBrainAccess();
  const partition = key("ORG", request.organizationId, "ENV", request.environmentId);

  if (initiator.type === "service-account") {
    const [serviceAccountValue, credentialValue, callerGrant] = await Promise.all([
      getControlRecord(database, {
        pk: partition,
        sk: key("SERVICE-ACCOUNT", initiator.serviceAccountId),
      }),
      getControlRecord(database, {
        pk: partition,
        sk: key("API-CREDENTIAL", initiator.apiCredentialId),
      }),
      repository.findActiveGrant(brain.organizationId, brain.id, {
        environmentId: request.environmentId,
        projectId: request.projectId,
        serviceAccountId: initiator.serviceAccountId,
        type: "service-account",
      }),
    ]);
    const serviceAccount = expected(serviceAccountValue, "service-account");
    const credential = expected(credentialValue, "api-credential");
    const now = new Date().toISOString();
    const decision = authorizeBrainAccess({
      ...shared,
      caller: {
        credentialActive:
          credential.data.status === "active" &&
          credential.data.revokedAt === undefined &&
          (!credential.data.expiresAt || credential.data.expiresAt > now) &&
          credential.data.serviceAccountId === serviceAccount.data.id,
        environmentId: request.environmentId,
        kind: "service",
        organizationId: request.organizationId,
        projectId: request.projectId,
        scopes: serviceScopes(credential, serviceAccount, operation),
        serviceAccountActive:
          serviceAccount.data.status === "active" &&
          serviceAccount.data.organizationId === request.organizationId &&
          serviceAccount.data.projectId === request.projectId &&
          serviceAccount.data.environmentId === request.environmentId,
        serviceAccountId: initiator.serviceAccountId,
      },
      ...(callerGrant ? { callerGrant } : {}),
    });
    if (!decision.allowed) return denyBrainAccess();
    return {
      actor: {
        apiCredentialId: initiator.apiCredentialId,
        environmentId: request.environmentId,
        kind: "service" as const,
        projectId: request.projectId,
        serviceAccountId: initiator.serviceAccountId,
      },
      agent,
      callerGrant: callerGrant!,
      subject,
    };
  }

  const [principalValue, membershipValue] = await Promise.all([
    getControlRecord(database, {
      pk: key("PRINCIPAL", initiator.principalId),
      sk: key("PRINCIPAL", initiator.principalId),
    }),
    getControlRecord(database, {
      pk: key("ORG", request.organizationId),
      sk: key("ORGANIZATION-MEMBER", initiator.principalId),
    }),
  ]);
  const principal = expected(principalValue, "principal");
  const membership = expected(membershipValue, "organization-member");
  const principalGrant = await repository.findActiveGrant(brain.organizationId, brain.id, {
    principalId: initiator.principalId,
    type: "principal",
  });
  const role = membership.data.role;
  const roleGrant =
    principalGrant || !canHoldBrainRoleGrant(role)
      ? undefined
      : await repository.findActiveGrant(brain.organizationId, brain.id, {
          organizationRole: role,
          type: "organization-role",
        });
  const callerGrant: BrainGrant | undefined = principalGrant ?? roleGrant;
  const decision = authorizeBrainAccess({
    ...shared,
    caller: {
      kind: "human",
      membershipActive: membership.data.status === "active",
      organizationRole: role,
      principalActive: principal.data.kind === "human" && principal.data.status === "active",
      principalId: initiator.principalId,
      scopes: initiator.scopes,
    },
    ...(callerGrant ? { callerGrant } : {}),
  });
  if (!decision.allowed) return denyBrainAccess();
  return {
    actor: { kind: "human" as const, principalId: initiator.principalId },
    agent,
    callerGrant: callerGrant!,
    subject,
  };
}

/** Live read authorization for customer runs and for preview runs via their source deployment. */
export async function authorizeBrainRead(input: BrainToolAuthorizationInput): Promise<void> {
  await authorizeRunBrainAccess({ ...input, operation: "read" });
}

/** Point-reads the Brain and returns it only if the run may read it now. */
export async function readableBrain(
  input: Omit<BrainToolAuthorizationInput, "brain"> & { readonly brainId: string },
): Promise<Brain | undefined> {
  const brain = await input.repository.get(input.request.organizationId, input.brainId);
  if (!brain) return undefined;
  try {
    await authorizeBrainRead({ ...input, brain });
    return brain;
  } catch {
    return undefined;
  }
}

/** Live write authorization; only customer runs, attributed to their published release, write. */
export async function authorizeBrainWrite(input: BrainToolAuthorizationInput) {
  const { actor, agent, callerGrant, subject } = await authorizeRunBrainAccess({
    ...input,
    operation: "write",
  });
  const { agentDefinitionGrant, mount } = agent;
  const release = subject.release;
  if (!agentDefinitionGrant || !mount || !release || release.data.contentHash.length === 0) {
    return denyBrainAccess();
  }
  return {
    actor,
    agentAuthorization: {
      agentDefinitionGrant,
      agentDefinitionId: subject.agentDefinitionId,
      agentDefinitionVersion: subject.definition.data.version,
      agentDeploymentId: subject.agentDeploymentId,
      agentDeploymentVersion: subject.deployment.data.version,
      agentReleaseContentHash: release.data.contentHash,
      agentReleaseId: release.data.id,
      agentReleaseVersion: release.data.version,
      callerGrant,
      mount,
    },
    authorizingGrant: agentDefinitionGrant,
    brain: input.brain,
  };
}
