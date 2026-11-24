import {
  makeModelGatewayRunLeaseReader,
  makeRunMessagePersistence,
  type DynamoDatabaseService,
} from "@deployments-ai/db";
import {
  agentModelGrantScope,
  MODEL_GATEWAY_RUN_TOKEN_TTL_SECONDS,
  type ModelRunLease,
  type ModelRunTokenRequest,
  type ModelTokenResponse,
} from "@deployments-ai/model-gateway";
import { compileAgentManifestRuntime } from "./agent-manifest-runtime.ts";
import { loadRunExecutionTarget, runExecutionProfile } from "./agent-run-execution-target.ts";
import {
  admitEnvironmentModels,
  dataBoundaryRefusal,
  modelTokenRefusal,
  standingRefusal,
  type ModelTokenIssuerDependencies,
} from "./model-token-issuer-admission.ts";
import { fundModelToken, organizationModelCredentials } from "./model-token-issuer-funding.ts";
import { mintModelGatewayToken } from "./model-token-signer.ts";
import type { RunRecordValue } from "./types.ts";

/** The run named by the request, through its thread-scoped run lookup. */
async function loadRequestedRun(
  database: DynamoDatabaseService,
  request: ModelRunLease,
): Promise<RunRecordValue | undefined> {
  const runs = makeRunMessagePersistence(database);
  const lookup = await runs.getRunLookup(request);
  if (!lookup) return undefined;
  if (
    lookup.itemType !== "run-lookup" ||
    lookup.data.runId !== request.runId ||
    lookup.data.organizationId !== request.organizationId ||
    lookup.data.threadId !== request.threadId
  ) {
    throw new Error(`Run lookup ${request.runId} does not match the requested run.`);
  }
  const run = await runs.getRun({
    idempotencyKey: lookup.data.idempotencyKey,
    organizationId: request.organizationId,
    threadId: request.threadId,
  });
  if (!run) return undefined;
  if (
    run.itemType !== "run" ||
    run.data.id !== request.runId ||
    run.data.organizationId !== request.organizationId ||
    run.data.threadId !== request.threadId ||
    run.data.idempotencyKey !== lookup.data.idempotencyKey
  ) {
    throw new Error(`Run lookup ${request.runId} does not resolve to its canonical run.`);
  }
  return run;
}

/**
 * The run `claim` names, while `leaseOwner` holds the run's thread execution lease and the run is
 * running under that claim.
 */
export async function claimedRunningRun(
  dependencies: Pick<ModelTokenIssuerDependencies, "database" | "now">,
  claim: ModelRunLease,
): Promise<
  | { readonly ok: true; readonly run: RunRecordValue }
  | { readonly ok: false; readonly refusal: ModelTokenResponse }
> {
  const lease = await makeModelGatewayRunLeaseReader(dependencies.database).getThreadExecutionLease(
    claim.threadId,
  );
  if (
    !lease ||
    lease.data.runId !== claim.runId ||
    lease.data.owner !== claim.leaseOwner ||
    (lease.data.organizationId !== undefined &&
      lease.data.organizationId !== claim.organizationId) ||
    !(Date.parse(lease.data.expiresAt) > dependencies.now().getTime())
  ) {
    return {
      ok: false,
      refusal: modelTokenRefusal(
        "lease_inactive",
        `Run ${claim.runId} does not hold an active thread execution lease for this owner.`,
      ),
    };
  }
  const run = await loadRequestedRun(dependencies.database, claim);
  if (!run) {
    return {
      ok: false,
      refusal: modelTokenRefusal("run_not_found", `Run ${claim.runId} was not found.`),
    };
  }
  if (run.data.status !== "running" || run.data.claimedBy !== claim.leaseOwner) {
    return {
      ok: false,
      refusal: modelTokenRefusal(
        "lease_inactive",
        `Run ${claim.runId} is not running under this lease owner.`,
      ),
    };
  }
  return { ok: true, run };
}

/**
 * Mints a run token only for a {@link claimedRunningRun}. The token carries the run's tenancy and
 * pins and the run's pinned primary and fallback models, re-admitted against the environment's
 * current model policy, the catalog, and the operator grants, and the funding claim naming the
 * organization's keys that pay for them.
 */
export async function issueRunModelToken(
  dependencies: ModelTokenIssuerDependencies,
  request: ModelRunTokenRequest,
): Promise<ModelTokenResponse> {
  const claimed = await claimedRunningRun(dependencies, request);
  if (!claimed.ok) return claimed.refusal;
  const { run } = claimed;
  const refused = await standingRefusal(dependencies, run.data.organizationId, "run.continue");
  if (refused) return refused;
  const profile = runExecutionProfile(
    await loadRunExecutionTarget(dependencies.database, run.data, run),
  );
  const manifest = compileAgentManifestRuntime(profile.manifest);
  const modelIds = [manifest.modelId, ...manifest.modelFallbackIds];
  const outsideBoundary = await dataBoundaryRefusal(
    dependencies,
    run.data.organizationId,
    modelIds,
  );
  if (outsideBoundary) return outsideBoundary;
  const credentials = await organizationModelCredentials(dependencies, run.data.organizationId);
  const admission = await admitEnvironmentModels(
    dependencies,
    {
      environment: run.data,
      // The scope the agent runtime's model calls are admitted under.
      grantScope: agentModelGrantScope({
        agentDefinitionId: profile.pins.agentDefinitionId,
        organizationId: run.data.organizationId,
        workspaceId: run.data.workspaceId,
      }),
    },
    modelIds,
    credentials,
  );
  if (!admission.ok) return admission.refusal;
  const funded = await fundModelToken(
    dependencies,
    run.data.organizationId,
    credentials,
    admission.models,
  );
  if (!funded.ok) return funded.refusal;
  const { pins } = profile;
  return mintModelGatewayToken(
    dependencies,
    {
      ...(pins.agentDefinitionId ? { agentDefinitionId: pins.agentDefinitionId } : {}),
      ...(pins.agentDeploymentId ? { agentDeploymentId: pins.agentDeploymentId } : {}),
      ...(pins.agentReleaseId ? { agentReleaseId: pins.agentReleaseId } : {}),
      environmentId: run.data.environmentId,
      ...(pins.executionBindingId ? { executionBindingId: pins.executionBindingId } : {}),
      ...(funded.funding ? { funding: funded.funding } : {}),
      kind: "run",
      leaseOwner: request.leaseOwner,
      models: funded.models,
      organizationId: run.data.organizationId,
      projectId: run.data.projectId,
      runId: run.data.id,
      sub: `run:${run.data.id}`,
      threadId: run.data.threadId,
      ...(run.data.workspaceId ? { workspaceId: run.data.workspaceId } : {}),
    },
    MODEL_GATEWAY_RUN_TOKEN_TTL_SECONDS,
  );
}
