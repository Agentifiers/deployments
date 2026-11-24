import type { ModelGatewayToolCall } from "@deployments-ai/model-gateway";
import type { RuntimeToolDefinition } from "./types.ts";

const GEMMA4_STOP_SEQUENCES = ["<turn|>", "\nthought\n", "\nthought:\n", "<|thought|>"] as const;
export const GEMMA4_ADDITIONAL_BODY = {
  // Bifrost's native chat handler captures provider-specific parameters only when
  // they are unknown top-level fields.
  chat_template_kwargs: { enable_thinking: false },
  min_p: 0.05,
  // Keep word-boundary tokens neutral; use response guards and recovery prompts for repetition.
  repetition_penalty: 1.0,
  stop: GEMMA4_STOP_SEQUENCES,
  temperature: 0.8,
} as const;
const NO_INITIATION_MARKER = "[NO_INITIATION]";
const MALFORMED_REPEAT_MINIMUM_CHARACTERS = 512;
const MAX_GEMMA4_ASSISTANT_CHARACTERS = 4_096;

type JsonObject = Readonly<Record<string, unknown>>;

export interface Gemma4ModelTool {
  readonly name: string;
  readonly tool: RuntimeToolDefinition;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

const SCALAR_SCHEMA_TYPES = new Set(["boolean", "integer", "null", "number", "string"]);

function schemaIsExplicitlyScalar(schema: JsonObject): boolean {
  const type = schema.type;
  return typeof type === "string" && SCALAR_SCHEMA_TYPES.has(type);
}

function requiredPropertyNames(
  schema: JsonObject,
  properties: JsonObject,
): ReadonlySet<string> | undefined {
  const required = schema.required;
  if (required === undefined) return new Set();
  if (
    !Array.isArray(required) ||
    required.some((propertyName) =>
      typeof propertyName === "string" ? !Object.hasOwn(properties, propertyName) : true,
    )
  ) {
    return undefined;
  }
  const names = new Set(required);
  return names.size === required.length ? names : undefined;
}

interface MalformedRepeatedThought {
  readonly repetitionStart: number;
  readonly visibleEnd: number;
}

function normalizedThoughtSegment(value: string) {
  return value
    .replace(/^thought(?:[ \t]+|[ \t]*:[ \t]*)/iu, "")
    .trim()
    .replace(
      /(?:[ \t]*(?:\p{P}|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*))+$/gu,
      "",
    )
    .trim()
    .replace(/\s+/gu, " ")
    .toLowerCase();
}

function malformedRepeatedThought(
  value: string,
  context: { readonly historical: boolean; readonly outputExhausted: boolean },
): MalformedRepeatedThought | undefined {
  const thoughtBoundaries = [
    ...value.matchAll(
      /(?:^[ \t]*|\r?\n[ \t]*|(?:\p{P}|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)[ \t]*)thought(?:[ \t]+|[ \t]*:[ \t]*(?=\r?\n|$))/giu,
    ),
  ].map((segment) => ({
    boundaryStart: segment.index,
    start: segment.index + segment[0].search(/thought/iu),
  }));
  const thoughtSegments = thoughtBoundaries.map(({ boundaryStart, start }, index) => {
    const end = thoughtBoundaries[index + 1]?.boundaryStart ?? value.length;
    const raw = value.slice(start, end);
    const content = normalizedThoughtSegment(raw);
    const withoutDurationTrailer = normalizedThoughtSegment(
      raw.replace(/(?:\r?\n[ \t]*\d+[ \t]*[smhd][ \t]*)+$/iu, ""),
    );
    const durationTrailer = raw.match(/(?:\r?\n[ \t]*\d+[ \t]*[smhd][ \t]*)+$/iu)?.[0] ?? "";
    const durationValues = [...durationTrailer.matchAll(/(\d+)[ \t]*([smhd])/giu)].map(
      (duration) => `${duration[1]}${duration[2]?.toLowerCase()}`,
    );
    const repeatedDurationTrailer =
      durationValues.length >= 2 && durationValues.every((value) => value === durationValues[0]);
    return {
      boundaryStart,
      content,
      end,
      repeatedDurationTrailer,
      start,
      withoutDurationTrailer,
    };
  });
  let streak = 1;
  for (let index = 1; index < thoughtSegments.length; index += 1) {
    const current = thoughtSegments[index]!;
    const previous = thoughtSegments[index - 1]!;
    const trailingDurationOnly =
      index === thoughtSegments.length - 1 &&
      current.withoutDurationTrailer !== current.content &&
      current.withoutDurationTrailer === previous.content;
    const trailingContentAfterRepeat =
      index === thoughtSegments.length - 1 && current.content.startsWith(`${previous.content} `);
    if (
      previous.content.length < 8 ||
      (current.content !== previous.content && !trailingDurationOnly && !trailingContentAfterRepeat)
    ) {
      streak = 1;
      continue;
    }
    streak += 1;
    const firstInRun = index - streak + 1;
    const repeatedSegmentEnd = trailingContentAfterRepeat
      ? current.start + (previous.end - previous.start)
      : current.end;
    const repeatedCharacters = repeatedSegmentEnd - thoughtSegments[firstInRun]!.start;
    if (
      (((context.outputExhausted && streak >= 6) || (context.historical && streak >= 10)) &&
        repeatedCharacters >= MALFORMED_REPEAT_MINIMUM_CHARACTERS) ||
      (streak >= 3 &&
        trailingDurationOnly &&
        (context.outputExhausted || current.repeatedDurationTrailer))
    ) {
      const repetitionStart = thoughtSegments[firstInRun]!.start;
      const visiblePrefix = value.slice(0, repetitionStart).trim();
      const preserveFirst =
        !visiblePrefix ||
        /^(?:\s|\p{P}|\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200D|\uFE0F)+$/u.test(
          visiblePrefix,
        );
      return {
        repetitionStart,
        visibleEnd: preserveFirst
          ? visiblePrefix
            ? thoughtSegments[firstInRun + 1]!.boundaryStart
            : thoughtSegments[firstInRun + 1]!.start
          : repetitionStart,
      };
    }
  }
  return undefined;
}

function preThoughtText(
  value: string,
  context: {
    readonly afterToolCompletion: boolean;
    readonly historical: boolean;
    readonly outputExhausted: boolean;
  },
): string {
  let content = value.trim();
  if (content.startsWith("<thought>")) {
    const thoughtEnd = content.indexOf("</thought>", "<thought>".length);
    if (thoughtEnd < 0) return "";
    content = content.slice(thoughtEnd + "</thought>".length).trim();
  }
  const closedThought = content.match(/^<\|channel>thought\n[\s\S]*?<channel\|>/u);
  if (closedThought) content = content.slice(closedThought[0].length).trim();
  if (content.startsWith("<channel|>")) {
    content = content.slice("<channel|>".length).trim();
  }
  if (context.afterToolCompletion) {
    const postToolControlLine = content.match(/^thought[ \t]*(?::[ \t]*)?\r?\n/iu);
    if (postToolControlLine) {
      const acknowledgement = textualToolAcknowledgement(
        content.slice(postToolControlLine[0].length),
      );
      if (!acknowledgement) return "";
      content = acknowledgement;
    }
  }
  if (/^(?:<\|)?thought(?:\|>)?[ \t]*(?::[ \t]*)?(?:\r?\n|$)/iu.test(content)) return "";
  const malformedThoughtBoundary = malformedRepeatedThought(content, context)?.visibleEnd ?? -1;
  const colonThoughtBoundary = content.search(/\r?\n[ \t]*thought[ \t]*:[ \t]*(?:\r?\n|$)/iu);
  const textualToolBoundary =
    content.match(/^(?=(?:<\|tool_call>)?_?call:)/iu) ??
    content.match(/[\s.!?;](?=(?:<\|tool_call>)?_?call:[A-Za-z0-9_.-]+\s*(?:\()?\s*\{)/iu);
  const markerIndexes = [
    content.indexOf("\nthought\n"),
    colonThoughtBoundary,
    malformedThoughtBoundary,
    textualToolBoundary?.index === undefined
      ? -1
      : textualToolBoundary.index + (/^[.!?;]$/u.test(textualToolBoundary[0]) ? 1 : 0),
    content.indexOf("<|thought|>"),
    content.indexOf("<thought>"),
    content.indexOf("</thought>"),
    content.indexOf("<|channel>thought\n"),
  ].filter((index) => index >= 0);
  if (markerIndexes.length > 0) content = content.slice(0, Math.min(...markerIndexes)).trim();
  return content;
}

function withoutNoInitiationMarker(value: string) {
  const lines = value.trim().split(/\r?\n/u);
  let removed = false;
  while (lines[0]?.trim().toUpperCase() === NO_INITIATION_MARKER) {
    lines.shift();
    removed = true;
  }
  while (lines.at(-1)?.trim().toUpperCase() === NO_INITIATION_MARKER) {
    lines.pop();
    removed = true;
  }
  return { content: lines.join("\n").trim(), removed };
}

function sanitizedGemma4AssistantText(
  value: string,
  context: {
    readonly afterToolCompletion: boolean;
    readonly historical: boolean;
    readonly outputExhausted: boolean;
  },
) {
  const beforeThought = withoutNoInitiationMarker(value);
  const afterThought = withoutNoInitiationMarker(preThoughtText(beforeThought.content, context));
  const content = afterThought.content;
  if (content.length > MAX_GEMMA4_ASSISTANT_CHARACTERS) return "";
  return content || (beforeThought.removed || afterThought.removed ? NO_INITIATION_MARKER : "");
}

export function gemma4OutputExhausted(finishReason?: string): boolean {
  return finishReason?.trim().toLowerCase() === "length";
}

export function gemma4AssistantText(
  value: string,
  finishReason?: string,
  afterToolCompletion = false,
): string {
  if (gemma4OutputExhausted(finishReason)) return "";
  return sanitizedGemma4AssistantText(value, {
    afterToolCompletion,
    historical: false,
    outputExhausted: false,
  });
}

export function gemma4HistoricalAssistantText(value: string): string {
  const content = sanitizedGemma4AssistantText(value, {
    afterToolCompletion: false,
    historical: true,
    outputExhausted: false,
  });
  return content === NO_INITIATION_MARKER ? "" : content;
}

function assertGemma4ToolCompatibility(tools: readonly Gemma4ModelTool[]): void {
  for (const { tool } of tools) {
    const schema = tool.inputSchema;
    const properties = asObject(schema?.properties);
    const patternProperties = asObject(schema?.patternProperties);
    if (
      schema?.additionalProperties !== false ||
      !properties ||
      !requiredPropertyNames(schema, properties) ||
      (patternProperties && Object.keys(patternProperties).length > 0) ||
      Object.values(properties).some((property) => {
        const propertySchema = asObject(property);
        return propertySchema ? !schemaIsExplicitlyScalar(propertySchema) : true;
      })
    ) {
      throw new Error(
        `Gemma 4 tool ${tool.toolName} requires a closed object schema with explicit scalar properties and a valid required-property list.`,
      );
    }
  }
}

function textualToolPropertyName(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(value) ? value : JSON.stringify(value);
}

export function gemma4ToolProtocol(tools: readonly Gemma4ModelTool[]): string {
  if (tools.length === 0) return "";
  assertGemma4ToolCompatibility(tools);
  const optionalFields: string[] = [];
  const signatures = tools.map(({ name, tool }) => {
    const schema = tool.inputSchema!;
    const properties = asObject(schema.properties)!;
    const required = requiredPropertyNames(schema, properties)!;
    const optional: string[] = [];
    const fields = Object.entries(properties).flatMap(([propertyName, property]) => {
      const propertySchema = asObject(property)!;
      const field = `${textualToolPropertyName(propertyName)}:<${propertySchema.type as string}>`;
      if (required.has(propertyName)) return [field];
      optional.push(field);
      return [];
    });
    if (optional.length > 0) optionalFields.push(`${name} optional fields: ${optional.join(",")}`);
    return `call:${name}{${fields.join(",")}}`;
  });
  return [
    "MODEL TOOL WIRE PROTOCOL (trusted runtime instructions)",
    "If a function is needed, emit only one complete call as the entire response, starting from exactly one of these required-field signatures:",
    ...signatures,
    ...(optionalFields.length > 0
      ? [
          "Optional fields may be added inside the matching call braces as ordinary comma-separated name:value pairs:",
          ...optionalFields,
          "Omit an optional field's entire name:value pair when it is not needed.",
        ]
      : []),
    "Replace every placeholder in the emitted call with a value matching the declared type.",
    "Never invent or rename a function or parameter.",
    "Never emit thought, thinking, or control markers.",
    "Otherwise emit only the user-visible reply.",
  ].join("\n");
}

function textualToolEnvelope(content: string):
  | {
      readonly arguments: string;
      readonly authoritativeBoundary: boolean;
      readonly name: string;
      readonly suffix: string;
    }
  | undefined {
  const rawContent = content.trim();
  const wrapped = rawContent.startsWith("<|tool_call>");
  const prefix = rawContent.match(/^(?:<\|tool_call>)?_?call:([A-Za-z0-9_.-]+)\s*(\()?\s*\{/u);
  const name = prefix?.[1];
  if (!prefix || !name) return undefined;
  const parenthesized = prefix[2] === "(";
  let depth = 1;
  let doubleQuoted = false;
  let singleQuoted = false;
  let escaped = false;
  for (let index = prefix[0].length; index < rawContent.length; index += 1) {
    const character = rawContent[index]!;
    if (doubleQuoted || singleQuoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (doubleQuoted && character === '"') doubleQuoted = false;
      else if (singleQuoted && character === "'") singleQuoted = false;
      continue;
    }
    if (character === '"') {
      doubleQuoted = true;
      continue;
    }
    if (character === "'" && /[:,[{]\s*$/u.test(rawContent.slice(0, index))) {
      singleQuoted = true;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") depth -= 1;
    if (depth !== 0) continue;
    let suffix = rawContent.slice(index + 1).trim();
    if (parenthesized) {
      if (!suffix.startsWith(")")) return undefined;
      suffix = suffix.slice(1).trim();
    }
    const closedWrapper = wrapped && suffix.startsWith("<tool_call|>");
    if (closedWrapper) suffix = suffix.slice("<tool_call|>".length).trim();
    return {
      arguments: rawContent.slice(prefix[0].length, index),
      authoritativeBoundary: affirmativeTextualToolAcknowledgementSuffix(suffix),
      name,
      suffix,
    };
  }
  return undefined;
}

function textualToolAcknowledgementSuffix(value: string): boolean {
  let suffix = value.trim();
  if (!suffix) return true;
  if (/(?:^|[\s.!?;])(?:<\|tool_call>)?_?call:/iu.test(suffix)) return false;
  if (
    /^(?:thought[ \t]*(?::[ \t]*)?(?:\r?\n|$)|<\|thought\|>|<\|channel>thought\n|<\/thought>)/u.test(
      suffix,
    )
  ) {
    return !toolSuffixContradictsAction(suffix);
  }
  if (suffix.length > 512) return false;
  for (;;) {
    const control = suffix.match(
      /^(?:on_(?:call|remind|success|tool_success)[ \t]*:|text(?:[ \t]*:|\r?\n|$))[ \t]*/iu,
    );
    if (!control) break;
    suffix = suffix.slice(control[0].length).trim();
    const ok = suffix.match(/^\[OK\][ \t]*/iu);
    if (ok) suffix = suffix.slice(ok[0].length).trim();
  }
  if (!suffix) return true;
  const quote = suffix[0];
  if ((quote === '"' || quote === "'") && suffix.endsWith(quote)) {
    suffix = suffix.slice(1, -1).trim();
  }
  return (
    textualToolAcknowledgement(suffix) !== undefined || textualToolCommitmentAcknowledgement(suffix)
  );
}

function affirmativeTextualToolAcknowledgementSuffix(value: string): boolean {
  let suffix = value.trim();
  const control = suffix.match(
    /^(?:on_(?:call|remind|success|tool_success)[ \t]*:|text(?:[ \t]*:|\r?\n|$))[ \t]*/iu,
  );
  if (!control) return false;
  suffix = suffix.slice(control[0].length).trim();
  const ok = suffix.match(/^\[OK\][ \t]*/iu);
  if (ok) suffix = suffix.slice(ok[0].length).trim();
  const quote = suffix[0];
  if ((quote === '"' || quote === "'") && suffix.endsWith(quote)) {
    suffix = suffix.slice(1, -1).trim();
  }
  return textualToolAcknowledgement(suffix) !== undefined;
}

const TOOL_CANCELLATION =
  /(?:\b(?:actually|cancel|changed? my mind|disregard|ignore|never[ \t]+mind|nevermind|no[ \t]+need|scratch|stop|wait)\b|\bforget[ \t]+(?:it|that|this|the[ \t]+(?:call|check[ \t]*in|follow[ \t]*up|message|reminder|request|schedule|text))\b|\b(?:can(?:'|’)t|cannot|could(?:n(?:'|’)t|[ \t]+not)|do[ \t]+not|don(?:'|’)t|must(?:n(?:'|’)t|[ \t]+not)|never|should(?:n(?:'|’)t|[ \t]+not)|will[ \t]+not|won(?:'|’)t|would(?:n(?:'|’)t|[ \t]+not))[ \t]+(?:call|check[ \t]+in|create|do|follow[ \t]+up|message|remind|run|schedule|send|text)\b)/iu;
const TOOL_FAILURE =
  /(?:\b(?:operation|request|reminder|schedule|tool)\b[^.!?\r\n]{0,80}\b(?:fail(?:ed|ure)?|unsuccessful)\b|\b(?:not[ \t]+able|unable)[ \t]+to[ \t]+(?:call|check[ \t]+in|create|do|follow[ \t]+up|message|remind|run|schedule|send|text)\b)/iu;
const TOOL_NONCOMMITMENT =
  /(?:\b(?:maybe|perhaps|possibly)\b|\b(?:need|require)[ \t]+(?:more|additional|some)[ \t]+(?:context|details?|info(?:rmation)?|input)\b|\b(?:need|have)[ \t]+to[ \t]+(?:ask|clarify|confirm|know)\b|\bnot[ \t]+sure\b)/iu;
const TOOL_NONEXECUTION =
  /\b(?:(?:did[ \t]+not|didn(?:'|’)t)[ \t]+|(?:declin|refus)(?:e|ed)[ \t]+to[ \t]+)(?:call|check[ \t]+in|create|do|follow[ \t]+up|message|remind|run|schedule|send|text)\b/iu;

function toolSuffixContradictsAction(value: string): boolean {
  const withoutPositiveReminderLanguage = value.replace(
    /\b(?:do[ \t]+not|don(?:'|’)t|never)[ \t]+(?:ever[ \t]+)?forget\b/giu,
    "remember",
  );
  return (
    TOOL_CANCELLATION.test(withoutPositiveReminderLanguage) ||
    TOOL_FAILURE.test(value) ||
    TOOL_NONCOMMITMENT.test(value) ||
    TOOL_NONEXECUTION.test(value)
  );
}
const TOOL_ACKNOWLEDGEMENT_PREFIX =
  /^(?:all[ \t]+set|done|got[ \t]+(?:it|you)|gotcha|okay|on[ \t]+it|sure|will[ \t]+do|yep|you[ \t]+got[ \t]+it)(?:[,;.!?])?(?:[ \t]+(.+))?$/iu;
const TOOL_COMMITMENT_ACKNOWLEDGEMENT_PREFIX =
  /^(?:all[ \t]+set|done|got[ \t]+(?:it|you)|gotcha|okay|on[ \t]+it|sure|will[ \t]+do|yep|you[ \t]+got[ \t]+it)(?:[,;.!?])?(?=$|[ \t\r\n])/iu;
const TOOL_ACKNOWLEDGEMENT_NUMBER_WORD = String.raw`(?:(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)|(?:twenty|thirty|forty|fifty)[ -](?:one|two|three|four|five|six|seven|eight|nine)|(?:twenty|thirty|forty|fifty|sixty))`;
const TOOL_ACKNOWLEDGEMENT_DELAY = String.raw`(?:a[ \t]+(?:(?:bit|minute|sec|second)|(?:couple|few)[ \t]+(?:hours?|mins?|minutes?|secs?|seconds?))|${TOOL_ACKNOWLEDGEMENT_NUMBER_WORD}|\d+(?:[ \t]*(?:hours?|mins?|minutes?|secs?|seconds?))?)`;
const TOOL_ACKNOWLEDGEMENT_CONTACT = String.raw`(?:(?:buzz|message|msg|ping|poke|text)(?:[ \t]+you)?|check(?:[ \t]+back)?(?:[ \t]+in)?(?:[ \t]+with[ \t]+you)?|hit[ \t]+you[ \t]+up|hmu)`;
const TOOL_ACKNOWLEDGEMENT_PROMISE = new RegExp(
  String.raw`^(?:(?:i(?:'|’)ll|i[ \t]+will)[ \t]+(?:(?:be[ \t]+(?:right[ \t]+)?back)(?:[ \t]+(?:after|in)[ \t]+${TOOL_ACKNOWLEDGEMENT_DELAY})?|${TOOL_ACKNOWLEDGEMENT_CONTACT}(?:[ \t]+(?:(?:after|in)[ \t]+${TOOL_ACKNOWLEDGEMENT_DELAY}|shortly|soon))?|(?:see[ \t]+you|talk)[ \t]+(?:after|in)[ \t]+${TOOL_ACKNOWLEDGEMENT_DELAY})|(?:see[ \t]+you|talk)[ \t]+(?:after|in)[ \t]+${TOOL_ACKNOWLEDGEMENT_DELAY}|you(?:'|’)ll[ \t]+hear[ \t]+from[ \t]+me(?:[ \t]+(?:after|in)[ \t]+${TOOL_ACKNOWLEDGEMENT_DELAY})?)(?:[.!?])?$`,
  "iu",
);

function textualToolAcknowledgement(value: string): string | undefined {
  const content = value.trim();
  if (!content || content.length > 512) return undefined;
  if (content.includes("?") || /\r?\n/u.test(content) || toolSuffixContradictsAction(content)) {
    return undefined;
  }
  if (/(?:<\|tool_call>|<tool_call\|>|\[NO_INITIATION\]|(?:^|[\s.!?;])_?call:)/iu.test(content)) {
    return undefined;
  }
  if (TOOL_ACKNOWLEDGEMENT_PROMISE.test(content)) return content;
  const acknowledgement = content.match(TOOL_ACKNOWLEDGEMENT_PREFIX);
  const tail = acknowledgement?.[1]?.trim();
  return acknowledgement && (!tail || TOOL_ACKNOWLEDGEMENT_PROMISE.test(tail))
    ? content
    : undefined;
}

function textualToolCommitmentAcknowledgement(value: string): boolean {
  const content = value.trim();
  if (!content || content.length > 512) return false;
  if (content.includes("?") || toolSuffixContradictsAction(content)) {
    return false;
  }
  if (/(?:<\|tool_call>|<tool_call\|>|\[NO_INITIATION\]|(?:^|[\s.!?;])_?call:)/iu.test(content)) {
    return false;
  }
  const acknowledgement = content.match(TOOL_COMMITMENT_ACKNOWLEDGEMENT_PREFIX);
  if (!acknowledgement) return false;
  const tail = content.slice(acknowledgement[0].length).trim();
  if (!tail) return true;
  // A completed, schema-valid call is the authoritative action. Models vary the discarded
  // natural confirmation after it, so validate that suffix structurally instead of coupling tool
  // execution to an open-ended list of English promise verbs. The continuation turn creates the
  // actual user-visible acknowledgement after the tool succeeds.
  return tail.split(/\s+/u).length <= 40 && tail.split(/\r?\n/u).length <= 3;
}

function parsedFieldName(
  value: string,
  start: number,
): { readonly name: string; readonly valueStart: number } | undefined {
  let index = start;
  while (/\s/u.test(value[index] ?? "")) index += 1;
  if (value[index] === '"') {
    let end = index + 1;
    let escaped = false;
    for (; end < value.length; end += 1) {
      const character = value[end]!;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') break;
    }
    if (end >= value.length) return undefined;
    let name: unknown;
    try {
      name = JSON.parse(value.slice(index, end + 1));
    } catch {
      return undefined;
    }
    index = end + 1;
    while (/\s/u.test(value[index] ?? "")) index += 1;
    if (typeof name !== "string" || value[index] !== ":") return undefined;
    return { name, valueStart: index + 1 };
  }
  const colon = value.indexOf(":", index);
  if (colon < 0) return undefined;
  const name = value.slice(index, colon).trim();
  return name && !/[{},\s]/u.test(name) ? { name, valueStart: colon + 1 } : undefined;
}

function schemaTypes(schema: JsonObject | undefined): ReadonlySet<string> {
  const type = schema?.type;
  return new Set(
    typeof type === "string"
      ? [type]
      : Array.isArray(type)
        ? type.filter((entry): entry is string => typeof entry === "string")
        : [],
  );
}

function textualToolScalar(value: string, schema: JsonObject | undefined): unknown {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const types = schemaTypes(schema);
  if (types.has("string")) {
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (typeof parsed === "string") return parsed;
      } catch {}
    }
    if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
    return trimmed;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/u, "$1$2");
  }
}

function textualToolArguments(
  value: string,
  properties: JsonObject,
): Readonly<Record<string, unknown>> | undefined {
  if (!value.trim()) return {};
  const fields: {
    readonly name: string;
    readonly separator: number;
    readonly valueStart: number;
  }[] = [];
  let quote: '"' | "'" | undefined;
  let escaped = false;
  let nesting = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (!quote && nesting === 0 && (index === 0 || character === ",")) {
      const parsed = parsedFieldName(value, index === 0 ? 0 : index + 1);
      if (parsed && Object.hasOwn(properties, parsed.name)) {
        fields.push({ name: parsed.name, separator: index, valueStart: parsed.valueStart });
        index = parsed.valueStart - 1;
        continue;
      }
      if (index === 0) return undefined;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"') {
      quote = character;
      continue;
    }
    if (character === "'" && /[:,[{]\s*$/u.test(value.slice(0, index))) {
      quote = character;
      continue;
    }
    if (character === "{" || character === "[" || character === "(") nesting += 1;
    else if (character === "}" || character === "]" || character === ")") nesting -= 1;
    if (nesting < 0) return undefined;
  }
  if (quote || nesting !== 0 || fields.length === 0) return undefined;
  const result: Record<string, unknown> = {};
  for (const [index, field] of fields.entries()) {
    if (Object.hasOwn(result, field.name)) return undefined;
    const end = fields[index + 1]?.separator ?? value.length;
    result[field.name] = textualToolScalar(
      value.slice(field.valueStart, end),
      asObject(properties[field.name]),
    );
  }
  return result;
}

export function gemma4TextualToolCall(
  content: string,
  modelTools: readonly Gemma4ModelTool[],
  options: { readonly requireAuthoritativeBoundary?: boolean } = {},
): ModelGatewayToolCall | undefined {
  const envelope = textualToolEnvelope(withoutNoInitiationMarker(content).content);
  if (!envelope) return undefined;
  if (options.requireAuthoritativeBoundary && !envelope.authoritativeBoundary) return undefined;
  if (!textualToolAcknowledgementSuffix(envelope.suffix)) return undefined;
  const modelTool = modelTools.find(
    ({ name, tool }) => envelope.name === name || envelope.name === tool.toolName,
  );
  if (!modelTool) return undefined;
  const properties = asObject(modelTool.tool.inputSchema?.properties);
  if (!properties) return undefined;
  const arguments_ = textualToolArguments(envelope.arguments, properties);
  return arguments_
    ? {
        arguments: arguments_,
        id: `gemma4-text-tool-${modelTools.indexOf(modelTool)}`,
        name: modelTool.name,
      }
    : undefined;
}
