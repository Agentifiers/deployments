import {
  key,
  makeExecutionBindingPersistence,
  workerPersistence,
  type DynamoDatabaseService,
  type PlatformRecord,
} from "@deployments-ai/db";

type MeterEvent = Extract<PlatformRecord, { readonly itemType: "meter-event" }>;

/** Runs whose agent one usage materializer container remembers. */
const MAX_CACHED_RUNS = 10_000;

async function get(
  database: DynamoDatabaseService,
  table: "control" | "execution",
  recordKey: { readonly pk: string; readonly sk: string },
) {
  return workerPersistence.read(database, table, recordKey, true);
}

/**
 * The agent definition a run executed. A run that pins a release (every customer run, and preview
 * and evaluation runs of bindings created from a published release) takes the release's
 * definition; releases are kept, while execution bindings expire hours after their runs. Other
 * binding runs take their binding's definition, which exists only for release-sourced bindings.
 *
 * Every record read here is committed before the run produces usage: the run and its locator in
 * one transaction when the run is created, its release or binding before that. The reads are
 * strongly consistent, so a record that is missing has been deleted (erasure, retention, binding
 * expiry) rather than not yet written, and the run's agent can no longer be named.
 */
async function runAgentDefinitionId(
  database: DynamoDatabaseService,
  event: MeterEvent["data"] & { readonly runId: string },
): Promise<string | undefined> {
  const { environmentId, organizationId, runId } = event;
  const environment = key("ORG", organizationId, "ENV", environmentId);
  const locator = await get(database, "control", {
    pk: environment,
    sk: key("RUN-LOCATOR", runId),
  });
  if (locator?.itemType !== "run-locator" || locator.data.id !== runId) return undefined;
  const run = await get(database, "execution", { pk: locator.data.runPk, sk: locator.data.runSk });
  if (
    run?.itemType !== "run" ||
    run.data.id !== runId ||
    run.data.environmentId !== environmentId ||
    run.data.organizationId !== organizationId
  ) {
    return undefined;
  }
  if (run.data.agentReleaseId !== undefined) {
    const release = await get(database, "control", {
      pk: environment,
      sk: key("AGENT-RELEASE", run.data.agentReleaseId),
    });
    return release?.itemType === "agent-release" ? release.data.agentDefinitionId : undefined;
  }
  if (run.data.executionBindingId === undefined) return undefined;
  const binding = await makeExecutionBindingPersistence(database).get({
    environmentId,
    executionBindingId: run.data.executionBindingId,
    organizationId,
  });
  return binding?.data.source.type === "release"
    ? binding.data.source.agentDefinitionId
    : undefined;
}

/**
 * Resolves the agent definition whose run produced a meter event, so the materializer can keep
 * per-agent counters. Every run-attributed writer (agent runtime, sandbox leases, memory, Brain
 * retrieval) names the run, and a run never changes its pins, so answers are cached per run; a
 * failed lookup is not cached, and fails the event's materialization so the stream retries it.
 * Events without a run (inbox traffic, Brain operations) attribute to no agent.
 */
export function createMeterEventAgentResolver(database: DynamoDatabaseService) {
  const cache = new Map<string, Promise<string | undefined>>();
  return (event: MeterEvent): Promise<string | undefined> => {
    const { runId } = event.data;
    if (runId === undefined) return Promise.resolve(undefined);
    const cacheKey = `${event.data.organizationId}/${event.data.environmentId}/${runId}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    const resolved = runAgentDefinitionId(database, { ...event.data, runId }).catch(
      (cause: unknown) => {
        cache.delete(cacheKey);
        throw cause;
      },
    );
    if (cache.size >= MAX_CACHED_RUNS) cache.delete(cache.keys().next().value!);
    cache.set(cacheKey, resolved);
    return resolved;
  };
}
