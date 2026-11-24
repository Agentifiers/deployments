import { isRecord } from "./types.ts";

export const RESPONSE_TOTAL_TOKEN_KEYS = ["totalTokens", "total_tokens"] as const;

export const RESPONSE_INPUT_TOKEN_KEYS = [
  "inputTokens",
  "promptTokens",
  "input_tokens",
  "prompt_tokens",
] as const;

export const RESPONSE_OUTPUT_TOKEN_KEYS = [
  "outputTokens",
  "completionTokens",
  "output_tokens",
  "completion_tokens",
] as const;

export function firstChatCompletionChoice(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body) || !Array.isArray(body.choices)) return undefined;
  return body.choices.find(isRecord);
}

export function textContentPart(part: unknown): string | undefined {
  if (typeof part === "string") return part;
  if (!isRecord(part)) return undefined;
  const text = part.text ?? part.content;
  return typeof text === "string" ? text : undefined;
}

export function chatCompletionMessageContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;

  const text = content
    .map(textContentPart)
    .filter((part): part is string => Boolean(part))
    .join("");

  return text.trim() ? text : undefined;
}
