import { Schema } from "effect";
import { ClientToolExpirationCommand, expireClientToolCall } from "./client-tool-expiration.ts";
import { cachedAgentRunWorkerDependencies } from "./worker-dependencies.ts";

/** EventBridge Scheduler target: fails an expired client tool call and resumes its run. */
export async function handler(event: unknown) {
  const command = Schema.decodeUnknownSync(ClientToolExpirationCommand)(event);
  const worker = await cachedAgentRunWorkerDependencies();
  const outcome = await expireClientToolCall(command, {
    ...(worker.appendThreadEvent ? { appendThreadEvent: worker.appendThreadEvent } : {}),
    database: worker.database,
    ...(worker.enqueueRun
      ? { enqueueRun: worker.enqueueRun, enqueueTerminalRun: worker.enqueueRun }
      : {}),
    generateId: worker.generateId,
    ...(worker.now ? { now: worker.now } : {}),
  });
  return { status: outcome.status, toolCallId: command.toolCallId };
}
