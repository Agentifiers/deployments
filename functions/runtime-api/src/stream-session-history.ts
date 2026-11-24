import type { ConversationMessage } from "@deployments-ai/conversations";
import { threadHistoryReplayState, type ThreadStreamSession } from "@deployments-ai/streaming";

export function streamSessionForReturnedHistory(
  session: ThreadStreamSession,
  history: readonly ConversationMessage[],
): ThreadStreamSession {
  const returnedReplayState = threadHistoryReplayState(
    { items: history },
    (message) => message.data.id,
    (message) => (message.data.role === "assistant" ? message.data.id : undefined),
  );
  return {
    ...session,
    replayState: {
      ...returnedReplayState,
      finalizedMessageIds: [
        ...new Set([
          ...session.replayState.finalizedMessageIds,
          ...returnedReplayState.finalizedMessageIds,
        ]),
      ],
      ...(session.replayState.historyThroughSequence !== undefined
        ? { historyThroughSequence: session.replayState.historyThroughSequence }
        : {}),
    },
  };
}
