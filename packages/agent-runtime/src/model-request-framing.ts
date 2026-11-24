import { conversationTimingInstruction } from "./conversation-temporal-context.ts";
import { RESPONSE_DISCIPLINE } from "./response-discipline.ts";
import type { RuntimeModelGenerationRequest } from "./types.ts";

const MAX_SKILL_CHARACTERS = 8 * 1024;
const MAX_SKILL_CONTEXT_CHARACTERS = 64 * 1024;
const SAME_MODEL_RETRY_PROTOCOL = [
  "RESPONSE RECOVERY (trusted runtime instructions)",
  "A previous attempt for this exact request did not produce a publishable complete response.",
  "Start over and produce one new complete response from scratch.",
  "Return either one complete valid tool call when a tool is needed, or one complete user-visible answer well within the output limit.",
  "Do not quote, continue, repeat, explain, or refer to the previous attempt.",
  "Do not include analysis, hidden reasoning, or control markers.",
  "End with meaningful content, not a laughter token or filler word. Do not mimic the endings of earlier assistant messages.",
  "Stop generating immediately after that response.",
].join("\n");

export function skillContext(skills: readonly string[]) {
  const entries: string[] = [];
  let remaining = MAX_SKILL_CONTEXT_CHARACTERS;
  for (const [index, skill] of skills.entries()) {
    const normalized = skill.trim();
    if (!normalized) throw new Error(`Pinned skill ${index + 1} must not be empty.`);
    if (normalized.length > MAX_SKILL_CHARACTERS) {
      throw new Error(`Pinned skill ${index + 1} exceeds its per-skill limit.`);
    }
    if (normalized.length > remaining) {
      throw new Error("Pinned skill context exceeds its total limit.");
    }
    entries.push(normalized);
    remaining -= normalized.length;
  }
  return entries;
}

export function trustedSystemPrompt(
  request: RuntimeModelGenerationRequest,
  modelToolProtocol = "",
): string {
  const skills = skillContext(request.skills);
  const conversationTiming = conversationTimingInstruction(request);
  return [
    request.instructions.trim() ||
      "You are a hosted software agent. Return the concise result of the run.",
    ...(conversationTiming ? ["", conversationTiming] : []),
    "",
    "Pinned skill instructions (trusted immutable release content):",
    skills.length > 0 ? skills.join("\n\n") : "none",
    "",
    RESPONSE_DISCIPLINE,
    ...(modelToolProtocol ? ["", modelToolProtocol] : []),
    ...(request.responseRecovery === "same-model-retry" ? ["", SAME_MODEL_RETRY_PROTOCOL] : []),
    ...(request.responseFormat
      ? [
          "",
          "FINAL RESPONSE CONTRACT (trusted caller-selected output format):",
          "After any tool calls, return exactly one complete JSON value satisfying the schema below. No Markdown fences, prose, commentary, or hidden reasoning outside the JSON. This explicit format supersedes ordinary text-length and response-style preferences; it does not change tool authorization.",
          `Contract name: ${request.responseFormat.name}`,
          JSON.stringify(request.responseFormat.schema),
        ]
      : []),
  ].join("\n");
}

export function runtimePromptMessage(
  request: RuntimeModelGenerationRequest,
  prompt: string,
  gemma4: boolean,
) {
  return {
    content:
      gemma4 && request.responseRecovery === "same-model-retry" && !request.responseFormat
        ? `${prompt}\n\nResponse recovery for the message above: give a complete new reply that ends at its last meaningful word. Use no laughter abbreviations or filler suffix. Do not mention these recovery instructions.`
        : prompt,
    role: "user",
  } as const;
}
