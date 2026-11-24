import { teamsTerminalText } from "@deployments-ai/channel-adapters/teams";
import type { PlatformRecord } from "@deployments-ai/db";
import {
  persistStreamTerminalFallback,
  requeueSuppressedStreamFallback,
} from "./channel-agent-stream-fallback.ts";
import type { AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";

type TeamsStream = Extract<PlatformRecord, { readonly itemType: "teams-agent-stream" }>;

export async function reconcileSuppressedTeamsFallback(
  dependencies: AgentRunWorkerDependencies,
  stream: TeamsStream,
) {
  await requeueSuppressedStreamFallback(dependencies, stream, {
    deliveryMode: "teams-stream-fallback",
    requeuedError: "Teams agent stream resolved; fallback delivery was requeued.",
    suppressedError: "Teams agent stream outcome is unknown; fallback delivery was suppressed.",
  });
}

/** Queues a failed or canceled run's notice; the delivery payload applies the agent identity. */
export async function persistTeamsTerminalFallback(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  stream: TeamsStream,
  body: string,
) {
  await persistStreamTerminalFallback(
    dependencies,
    run,
    stream,
    teamsTerminalText({ body, status: run.data.status as "canceled" | "completed" | "failed" }),
  );
}
