import type {
  ArchiveAgentResourceRequest,
  CreateAgentDefinitionRequest,
  UpdateAgentDefinitionRequest,
  ResolveAgentDeploymentCanaryRequest,
  StartAgentDeploymentCanaryRequest,
  UpdateAgentDeploymentRequest,
} from "@deployments-ai/api-contract/agents";
import { createServerFn } from "@tanstack/react-start";
import {
  archiveAgentDefinition as archiveDefinition,
  createAgentDefinition as createDefinition,
  resolveAgentDeploymentCanary,
  startAgentDeploymentCanary as startCanary,
  stopAgentDeployment as stopDeployment,
  updateAgentDefinition as updateDefinition,
  updateAgentDeployment as updateDeployment,
} from "../server/agent-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import { keyedInput, requireBody, type KeyedInput } from "./server-input.ts";

/**
 * Agent mutations. Callers send the contract's encoded (wire) body shapes; on arrival the
 * validators re-check the IDs and idempotency key, and handlers decode the body against the
 * operation's contract schema.
 */

interface MutationInput<Body> extends KeyedInput {
  readonly body: Body;
}

interface DeploymentInput<Body> extends MutationInput<Body> {
  readonly deploymentId: string;
}

interface DefinitionInput<Body> extends MutationInput<Body> {
  readonly definitionId: string;
}

function deploymentInput(input: unknown) {
  return { ...keyedInput(input, ["deploymentId"]), body: requireBody(input) };
}

function definitionInput(input: unknown) {
  return { ...keyedInput(input, ["definitionId"]), body: requireBody(input) };
}

/** Creates a definition from a manifest, optionally owned by one workspace. */
export const createAgentDefinitionFn = createServerFn({ method: "POST" })
  .validator((input: MutationInput<typeof CreateAgentDefinitionRequest.Encoded>) => ({
    ...keyedInput(input),
    body: requireBody(input),
  }))
  .handler(async ({ data }) =>
    createDefinition({ ...data, accessToken: await requireAccessToken() }),
  );

/** Replaces the definition's draft manifest at the version the editor loaded. */
export const updateAgentDefinitionFn = createServerFn({ method: "POST" })
  .validator((input: DefinitionInput<typeof UpdateAgentDefinitionRequest.Encoded>) =>
    definitionInput(input),
  )
  .handler(async ({ data }) =>
    updateDefinition({ ...data, accessToken: await requireAccessToken() }),
  );

/** Archives the definition: no more edits or releases; deployments keep running. */
export const archiveAgentDefinitionFn = createServerFn({ method: "POST" })
  .validator((input: DefinitionInput<typeof ArchiveAgentResourceRequest.Encoded>) =>
    definitionInput(input),
  )
  .handler(async ({ data }) =>
    archiveDefinition({ ...data, accessToken: await requireAccessToken() }),
  );

/** Retargets, pauses, or resumes a deployment; tool bindings have their own server function. */
export const updateAgentDeploymentFn = createServerFn({ method: "POST" })
  .validator(
    (input: DeploymentInput<Omit<typeof UpdateAgentDeploymentRequest.Encoded, "runtimeConfig">>) =>
      deploymentInput(input),
  )
  .handler(async ({ data }) =>
    updateDeployment({ ...data, accessToken: await requireAccessToken() }),
  );

/** Stops a deployment; it cannot be resumed afterwards. */
export const stopAgentDeploymentFn = createServerFn({ method: "POST" })
  .validator((input: DeploymentInput<typeof ArchiveAgentResourceRequest.Encoded>) =>
    deploymentInput(input),
  )
  .handler(async ({ data }) =>
    stopDeployment({ ...data, accessToken: await requireAccessToken() }),
  );

/** Routes a share of new threads to a candidate release. */
export const startAgentDeploymentCanaryFn = createServerFn({ method: "POST" })
  .validator((input: DeploymentInput<typeof StartAgentDeploymentCanaryRequest.Encoded>) =>
    deploymentInput(input),
  )
  .handler(async ({ data }) => startCanary({ ...data, accessToken: await requireAccessToken() }));

/** Makes the canary candidate the deployment's primary release. */
export const promoteAgentDeploymentCanaryFn = createServerFn({ method: "POST" })
  .validator((input: DeploymentInput<typeof ResolveAgentDeploymentCanaryRequest.Encoded>) =>
    deploymentInput(input),
  )
  .handler(async ({ data }) =>
    resolveAgentDeploymentCanary("promoteAgentDeploymentCanary", {
      ...data,
      accessToken: await requireAccessToken(),
    }),
  );

/** Ends the canary; every new thread goes to the primary release again. */
export const abortAgentDeploymentCanaryFn = createServerFn({ method: "POST" })
  .validator((input: DeploymentInput<typeof ResolveAgentDeploymentCanaryRequest.Encoded>) =>
    deploymentInput(input),
  )
  .handler(async ({ data }) =>
    resolveAgentDeploymentCanary("abortAgentDeploymentCanary", {
      ...data,
      accessToken: await requireAccessToken(),
    }),
  );
