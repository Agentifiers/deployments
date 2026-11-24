import type { OpenAiCompatibleChatCompletionMessage } from "@deployments-ai/model-gateway";

function isPlainAssistantMessage(
  message: OpenAiCompatibleChatCompletionMessage | undefined,
): message is OpenAiCompatibleChatCompletionMessage & { readonly content: string } {
  return (
    message?.role === "assistant" &&
    typeof message.content === "string" &&
    message.tool_call_id === undefined &&
    (message.tool_calls === undefined || message.tool_calls.length === 0)
  );
}

export function gemma4ChatTemplateMessages(
  messages: readonly OpenAiCompatibleChatCompletionMessage[],
): readonly OpenAiCompatibleChatCompletionMessage[] {
  const result: OpenAiCompatibleChatCompletionMessage[] = [];
  for (const message of messages) {
    const previous = result.at(-1);
    if (isPlainAssistantMessage(previous) && isPlainAssistantMessage(message)) {
      // The Gemma 4 template suppresses the next model-turn opener for adjacent
      // assistant messages even though it already closed the previous turn. Preserve legitimate
      // multi-message replies while keeping every assistant token inside one model turn.
      result[result.length - 1] = {
        content: `${previous.content}\n\n${message.content}`,
        role: "assistant",
      };
      continue;
    }
    result.push(message);
  }
  return result;
}
