import {
  slackAgentPlanChunks,
  slackProgressChunks,
  type SlackAgentProgress,
} from "@deployments-ai/channel-adapters/slack";
import { makeAgentRunPlanPersistence } from "@deployments-ai/db";
import type { AgentPlanUpdate } from "@deployments-ai/streaming";
import { withinSlackAgentProgressBudget } from "./slack-agent-progress-budget.ts";
import { slackAgentStreamToken } from "./slack-agent-stream-authorization.ts";
import { loadSlackAgentStream } from "./slack-agent-stream.ts";
import type { AgentRunWorkerDependencies, RunRecordValue } from "./types.ts";

export async function appendSlackAgentProgress(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  progress: SlackAgentProgress,
) {
  const stream = await loadSlackAgentStream(dependencies, run);
  if (!stream || stream.data.status !== "streaming" || !stream.data.streamTs) return;
  const plan = await makeAgentRunPlanPersistence(dependencies.database).load({
    organizationId: run.data.organizationId,
    runId: run.data.id,
  });
  if (plan?.data.runExecutionVersion === stream.data.runExecutionVersion) return;
  const client = dependencies.slackAgentStream;
  if (!client) return;
  const chunks = slackProgressChunks(progress);
  if (chunks.length === 0) return;
  const streamTs = stream.data.streamTs;
  await withinSlackAgentProgressBudget(
    dependencies,
    `${run.data.id}:${stream.data.runExecutionVersion}`,
    async () => {
      try {
        await client.append(await slackAgentStreamToken(dependencies, stream), {
          channel: stream.data.channelId,
          chunks,
          ts: streamTs,
        });
      } catch {
        return;
      }
    },
  );
}

export async function appendSlackAgentPlan(
  dependencies: AgentRunWorkerDependencies,
  run: RunRecordValue,
  runExecutionVersion: number,
  update: AgentPlanUpdate,
) {
  const stream = await loadSlackAgentStream(dependencies, run);
  if (
    !stream ||
    stream.data.status !== "streaming" ||
    !stream.data.streamTs ||
    stream.data.runExecutionVersion !== runExecutionVersion
  ) {
    return;
  }
  const client = dependencies.slackAgentStream;
  if (!client) return;
  const chunks = slackAgentPlanChunks(update);
  if (chunks.length === 0) return;
  await withinSlackAgentProgressBudget(
    dependencies,
    `${run.data.id}:${runExecutionVersion}`,
    async () => {
      try {
        await client.append(await slackAgentStreamToken(dependencies, stream), {
          channel: stream.data.channelId,
          chunks,
          ts: stream.data.streamTs!,
        });
      } catch {
        return;
      }
    },
  );
}
