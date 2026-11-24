import type { PlatformRecord } from "@deployments-ai/db";
import {
  slackStreamMarkdownText,
  type SlackStreamChunk,
} from "@deployments-ai/channel-adapters/slack";
import {
  persistStreamTerminalFallback,
  requeueSuppressedStreamFallback,
} from "./channel-agent-stream-fallback.ts";
import type { AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";

type SlackStream = Extract<PlatformRecord, { readonly itemType: "slack-agent-stream" }>;

export async function reconcileSuppressedFallback(
  dependencies: AgentRunWorkerDependencies,
  stream: SlackStream,
) {
  await requeueSuppressedStreamFallback(dependencies, stream, {
    deliveryMode: "slack-stream-fallback",
    requeuedError: "Slack agent stream resolved; fallback delivery was requeued.",
    suppressedError: "Slack agent stream outcome is unknown; fallback delivery was suppressed.",
  });
}

export async function persistTerminalFallback(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  stream: SlackStream,
  chunks: readonly SlackStreamChunk[],
) {
  await persistStreamTerminalFallback(dependencies, run, stream, slackStreamMarkdownText(chunks));
}
