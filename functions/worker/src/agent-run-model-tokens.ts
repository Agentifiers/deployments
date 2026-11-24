import {
  makeModelGatewayTokenCache,
  modelServiceTokenRequest,
  ModelTokenIssuanceError,
  type IssuedModelGatewayToken,
  type ModelGatewayCredentials,
  type ModelRunLease,
  type ModelTokenRequest,
} from "@deployments-ai/model-gateway";

/** The claim a worker holds on a run: the run token issuer mints only while it is current. */
export interface AgentRunModelLease {
  readonly leaseOwner: string;
  readonly organizationId: string;
  readonly runId: string;
  readonly threadId: string;
}

/**
 * Process-local map of the runs this worker currently holds a claim on. The agent generation
 * gateway mints run tokens only for registered runs, so a model call outside a held claim fails
 * before reaching the issuer.
 */
export interface AgentRunModelTokenRegistry {
  readonly lease: (runId: string) => AgentRunModelLease | undefined;
  /** Registers a held claim; the returned function removes exactly this registration. */
  readonly register: (lease: AgentRunModelLease) => () => void;
}

export function makeAgentRunModelTokenRegistry(): AgentRunModelTokenRegistry {
  const leases = new Map<string, AgentRunModelLease>();
  return {
    lease: (runId) => leases.get(runId),
    register: (lease) => {
      const registered = { ...lease };
      leases.set(lease.runId, registered);
      return () => {
        if (leases.get(lease.runId) === registered) leases.delete(lease.runId);
      };
    },
  };
}

/** The claim this worker holds on `runId`; model calls outside a held claim fail here. */
function heldLease(registry: AgentRunModelTokenRegistry, runId: string | undefined): ModelRunLease {
  const lease = runId ? registry.lease(runId) : undefined;
  if (!lease) {
    throw new ModelTokenIssuanceError(
      "lease_inactive",
      "Model calls require a run this worker currently holds a claim on.",
    );
  }
  return {
    leaseOwner: lease.leaseOwner,
    organizationId: lease.organizationId,
    runId: lease.runId,
    threadId: lease.threadId,
  };
}

/**
 * Credentials for the agent generation gateway: each request's `scope.runId` selects the
 * registered claim, and the run token issuer re-checks that claim before minting.
 */
export function agentRunModelGatewayCredentials(input: {
  readonly issue: (request: ModelTokenRequest) => Promise<IssuedModelGatewayToken>;
  readonly now?: () => number;
  readonly registry: AgentRunModelTokenRegistry;
}): ModelGatewayCredentials {
  const tokens = makeModelGatewayTokenCache(input.issue, input.now);
  return async (request) =>
    tokens({ kind: "run", ...heldLease(input.registry, request.scope?.runId) });
}

/**
 * Credentials for the Brain queries of the run `runId`: the worker's service token, naming the
 * run's organization (whose keys and ceiling fund it) and carrying the claim this worker holds on
 * the run, so the issuer admits it on the run's standing. Runs share one token cache.
 */
export function inRunBrainModelCredentials(input: {
  readonly issue: (request: ModelTokenRequest) => Promise<IssuedModelGatewayToken>;
  readonly now?: () => number;
  readonly registry: AgentRunModelTokenRegistry;
}): (runId: string) => ModelGatewayCredentials {
  const tokens = makeModelGatewayTokenCache(input.issue, input.now);
  return (runId) => async (request) => {
    const run = heldLease(input.registry, runId);
    return tokens(
      modelServiceTokenRequest(request.modelIds, {
        context: { organizationId: run.organizationId, runId: run.runId },
        run,
      }),
    );
  };
}
