import type { OpenAiCompatibleChatCompletionMessage } from "@deployments-ai/model-gateway";

const CONSERVATIVE_UTF8_BYTES_PER_TOKEN = 1;
const TRUNCATION_MARKER = "\n[truncated]";
export const CHAT_MESSAGE_OVERHEAD_TOKENS = 6;
export const REQUEST_OVERHEAD_TOKENS = 16;
const TEXT_PART_OVERHEAD_TOKENS = 8;

export class RuntimeContextBudgetError extends Error {
  override readonly name = "RuntimeContextBudgetError";
}

export function estimateRuntimeContextTokens(value: string): number {
  return Math.ceil(new TextEncoder().encode(value).byteLength / CONSERVATIVE_UTF8_BYTES_PER_TOKEN);
}

export function estimatedMessageTokens(message: OpenAiCompatibleChatCompletionMessage): number {
  // Base64 bytes are transport encoding, not text tokens. Reserve multimodal capacity
  // separately; never drop a media part when reducing optional textual history.
  const contentTokens =
    typeof message.content === "string"
      ? estimateRuntimeContextTokens(message.content)
      : message.content.reduce<number>(
          (total, part: unknown) => {
            if (!part || typeof part !== "object")
              return total + estimateRuntimeContextTokens(JSON.stringify(part) ?? "null");
            const value = part as Record<string, unknown>;
            if (value.type === "image_url") return total + 16_384;
            if (value.type === "input_audio") return total + 32_768;
            if (value.type === "text" && typeof value.text === "string") {
              return total + estimateRuntimeContextTokens(value.text) + TEXT_PART_OVERHEAD_TOKENS;
            }
            return total + estimateRuntimeContextTokens(JSON.stringify(part));
          },
          2 + Math.max(0, message.content.length - 1),
        );
  const protocol =
    message.tool_call_id || message.tool_calls || message.reasoning_details
      ? JSON.stringify({
          ...(message.reasoning_details ? { reasoning_details: message.reasoning_details } : {}),
          ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
          ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
        })
      : "";
  return CHAT_MESSAGE_OVERHEAD_TOKENS + contentTokens + estimateRuntimeContextTokens(protocol);
}

function utf8Prefix(encoded: Uint8Array, maximumBytes: number): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const end = Math.min(encoded.byteLength, maximumBytes);
  for (let offset = 0; offset <= Math.min(3, end); offset += 1) {
    try {
      return decoder.decode(encoded.subarray(0, end - offset));
    } catch {
      // Retry before the UTF-8 code point that spans the byte boundary.
    }
  }
  return "";
}

function utf8Suffix(encoded: Uint8Array, maximumBytes: number): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const start = Math.max(0, encoded.byteLength - maximumBytes);
  for (let offset = 0; offset <= Math.min(3, encoded.byteLength - start); offset += 1) {
    try {
      return decoder.decode(encoded.subarray(start + offset));
    } catch {
      // Retry after the UTF-8 code point that spans the byte boundary.
    }
  }
  return "";
}

export function textWithinTokenBudget(value: string, maximumTokens: number): string {
  if (estimateRuntimeContextTokens(value) <= maximumTokens) return value;
  const maximumBytes = Math.max(0, maximumTokens * CONSERVATIVE_UTF8_BYTES_PER_TOKEN);
  const encoded = new TextEncoder().encode(value);
  if (maximumBytes <= TRUNCATION_MARKER.length) return "";
  const markerBytes = new TextEncoder().encode(TRUNCATION_MARKER).byteLength;
  const retainedBytes = Math.max(0, maximumBytes - markerBytes);
  const prefixBytes = Math.floor(retainedBytes / 2);
  const suffixBytes = retainedBytes - prefixBytes;
  const prefix = utf8Prefix(encoded, prefixBytes);
  const suffix = utf8Suffix(encoded, suffixBytes);
  return `${prefix}${TRUNCATION_MARKER}${suffix}`;
}
