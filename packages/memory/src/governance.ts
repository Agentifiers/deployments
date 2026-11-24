import { createHash, timingSafeEqual } from "node:crypto";
import {
  conversationMessagePrefix,
  type MemoryConversationMessage,
} from "./conversation-transcript.ts";
import { MemoryCheckpointSizeError } from "./flush-errors.ts";

export interface MemoryContentInspection {
  readonly blockedReason?: string;
  readonly content: string;
  readonly redacted: boolean;
  readonly reviewReason?: string;
  readonly reviewStatus: "approved" | "pending";
  readonly sensitivity: "internal" | "restricted";
}

export type MemoryScope = "agent" | "organization" | "thread" | "workspace";
export type MemoryReviewMode = "auto-approve" | "manual";
export type MemoryTranscriptPrivacy = "omit" | "redact" | "retain";
export type MemoryType = "episode" | "fact" | "preference" | "procedure" | "summary";

export interface MemoryFlushCandidate {
  readonly confidence?: number;
  readonly content: string;
  readonly entityKeys?: readonly string[];
  readonly importance?: number;
  readonly memoryType?: MemoryType;
  readonly reason?: string;
  readonly scope?: MemoryScope;
  readonly sourceQuality?: number;
  readonly supersedesMemoryId?: string;
  readonly validFrom?: string;
  readonly validUntil?: string;
}

export const MEMORY_FLUSH_PROMPT_VERSION = "memory-flush-v2";
export const MEMORY_FLUSH_MAX_CANDIDATES = 10;
export const MEMORY_FLUSH_MAX_MESSAGE_CHARS = 12_000;
export const MEMORY_FLUSH_MAX_TRANSCRIPT_CHARS = 96_000;
export const MEMORY_FLUSH_CHECKPOINT_TRANSCRIPT_CHARS = 64_000;
export const MEMORY_FLUSH_CURRENT_RUN_TRANSCRIPT_CHARS =
  MEMORY_FLUSH_MAX_TRANSCRIPT_CHARS - MEMORY_FLUSH_CHECKPOINT_TRANSCRIPT_CHARS;
export const MEMORY_FLUSH_MIN_RECENT_MESSAGES = 2;
export const MEMORY_FLUSH_MAX_OUTPUT_TOKENS = 4_096;
export const MEMORY_FLUSH_TOKEN_THRESHOLD = 16_000;
export const MEMORY_FLUSH_REVIEW_SAMPLE_RATE = 0.1;
export const MEMORY_CHECKPOINT_MAX_BYTES = 8 * 1_024;
export const MEMORY_IMPORT_REVIEW_SAMPLE_RATE = 0.05;
export const MEMORY_BROAD_SCOPE_REVIEW_REASON =
  "Generated workspace or organization memory requires human review before recall.";

export function memoryFlushOutputTokenLimit(
  modelMaximumOutputTokens: number = MEMORY_FLUSH_MAX_OUTPUT_TOKENS,
) {
  return Math.min(MEMORY_FLUSH_MAX_OUTPUT_TOKENS, modelMaximumOutputTokens);
}

const memoryScopes = new Set<MemoryScope>(["agent", "organization", "thread", "workspace"]);
const memoryTypes = new Set<MemoryType>(["episode", "fact", "preference", "procedure", "summary"]);
const scopeRank: Record<MemoryScope, number> = {
  agent: 2,
  organization: 4,
  thread: 1,
  workspace: 3,
};
const orderedScopes: readonly MemoryScope[] = ["thread", "agent", "workspace", "organization"];

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
// UUIDs and hex ids such as commit SHAs carry digit runs that read as phone numbers, so a single
// pass matches them first and leaves them unchanged.
const phoneOrHexIdentifierPattern =
  /(?<identifier>(?<![0-9a-z])(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|(?=[0-9]*[a-f])[0-9a-f]{7,64})(?![0-9a-z]))|(?<!\d)(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}(?!\d)/giu;
const ssnPattern = /\b\d{3}-\d{2}-\d{4}\b/gu;
// The pattern is case-sensitive so it can tell a quantity from a street name. A lowercase unit of
// time, distance, or count right after the number is a quantity ("45 minutes each way", "a 5 mile
// drive"); a capitalized one names the street ("412 Second Street", "9 Mile Rd", "120 Day Street"),
// so an all-lowercase "9 mile rd" reads as a distance. A street name never contains a function
// word, so "2 drinks on the way" is not an address.
const anyCase = (alternatives: string) =>
  alternatives.replace(/[a-z]/gu, (letter) => `[${letter}${letter.toUpperCase()}]`);
const addressQuantityUnits =
  "blocks?|days?|feet|foot|ft|hours?|hrs?|kilomet(?:er|re)s?|km|met(?:er|re)s?|miles?|mins?|minutes?|months?|secs?|seconds?|steps?|times?|weeks?|yards?|years?|yrs?";
const nonStreetNameWords = anyCase(
  "across|along|an|and|another|any|are|around|at|both|but|by|down|each|either|every|for|from|he|her|his|in|into|is|it|its|me|my|of|off|on|onto|or|other|our|over|per|she|some|that|the|their|them|these|they|this|those|through|to|up|us|was|we|were|with|you|your",
);
const streetTypes = anyCase(
  "avenue|ave|boulevard|blvd|circle|cir|court|ct|drive|dr|highway|hwy|lane|ln|parkway|pkwy|road|rd|street|st|way",
);
const unitDesignators = anyCase("apartment|apt|suite|unit");
const streetAddressPattern = new RegExp(
  String.raw`\b\d{1,6}\s+(?!(?:${addressQuantityUnits})\b)(?:(?!(?:${nonStreetNameWords})\b)[A-Za-z0-9.'-]+\s+){0,5}(?:${streetTypes})\b(?:\s*(?:${unitDesignators}|#)\s*[A-Za-z0-9-]+)?`,
  "gu",
);
const dateOfBirthPattern =
  /\b(?:born(?:\s+on)?|date\s+of\s+birth|dob)\s*(?::|is|was)?\s*(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2},?\s+\d{4})\b/giu;
const healthPattern =
  /\b(aids|allergy|anxiety|asthma|blood pressure|cancer|condition|depression|diabetes|diagnosis|diagnosed|disease|disorder|hiv|hipaa|infection|lab result|medical record|medication|mental health|mrn|patient|pregnancy|pregnant|prescription|surgery|symptom|syndrome|therapy|treatment)\b/iu;

function redactPhones(value: string) {
  return value.replace(
    phoneOrHexIdentifierPattern,
    (_match: string, identifier: string | undefined) => identifier ?? "[redacted phone]",
  );
}
const secretPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}\b/iu,
  /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}\b/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[oprsu]_[A-Za-z0-9_]{20,}\b/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /\b(?:xox(?:[a-z]-|e\.xoxb-)|xapp-)[A-Za-z0-9._-]+\b/iu,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/u,
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{7,}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/@]+:[^@\s]+@[^\s]+/iu,
  /(?:^|[\s{,])["']?(?:api[_\s-]?key|auth(?:orization)?|password|passwd|private[_\s-]?key|secret|token)["']?\s*[:=]\s*["']?\S+/iu,
  /\b(?:the\s+)?(?:access\s+token|api\s+key|auth(?:orization)?\s+token|aws\s+secret\s+access\s+key|client\s+secret|database\s+password|db\s+password|encryption\s+key|password|passwd|private\s+key|refresh\s+token|secret\s+key|signing\s+key|token)\s+(?:is|was)\s+(?:"[^"]{4,}"|'[^']{4,}'|\S{4,})/iu,
] as const;

const structuredSecretKeys = new Set([
  "apikey",
  "accesstoken",
  "authorization",
  "auth",
  "awssecretaccesskey",
  "clientsecret",
  "encryptionkey",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secret",
  "secretkey",
  "signingkey",
  "token",
]);

function normalizedSecretKey(value: string) {
  return value.toLowerCase().replace(/[^a-z]/gu, "");
}

function isSecretKey(value: string) {
  const normalized = normalizedSecretKey(value);
  return [...structuredSecretKeys].some(
    (secretKey) => normalized === secretKey || normalized.endsWith(secretKey),
  );
}

function containsStructuredSecret(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsStructuredSecret);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([name, entry]) =>
      (isSecretKey(name) && entry !== null && entry !== undefined && String(entry).length > 0) ||
      containsStructuredSecret(entry),
  );
}

function hasStructuredSecret(content: string) {
  try {
    return containsStructuredSecret(JSON.parse(content) as unknown);
  } catch {
    return false;
  }
}

function hasSecretAssignment(content: string) {
  const assignments = content.matchAll(
    /(?:^|[\s;,])(?:export\s+)?([A-Za-z][A-Za-z0-9_.-]*)\s*[:=]\s*(?:"[^"]+"|'[^']+'|\S+)/giu,
  );
  for (const match of assignments) {
    if (isSecretKey(match[1] ?? "")) return true;
  }
  return false;
}

function containsSecretPattern(value: unknown): boolean {
  if (typeof value === "string") {
    return hasSecretAssignment(value) || secretPatterns.some((pattern) => pattern.test(value));
  }
  if (Array.isArray(value)) return value.some(containsSecretPattern);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([name, entry]) => containsSecretPattern(name) || containsSecretPattern(entry),
  );
}

function containsPersonalMetadata(value: unknown): boolean {
  if (typeof value === "string") {
    emailPattern.lastIndex = 0;
    ssnPattern.lastIndex = 0;
    streetAddressPattern.lastIndex = 0;
    dateOfBirthPattern.lastIndex = 0;
    return (
      emailPattern.test(value) ||
      redactPhones(value) !== value ||
      ssnPattern.test(value) ||
      streetAddressPattern.test(value) ||
      dateOfBirthPattern.test(value) ||
      healthPattern.test(value)
    );
  }
  if (Array.isArray(value)) return value.some(containsPersonalMetadata);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([name, entry]) => containsPersonalMetadata(name) || containsPersonalMetadata(entry),
  );
}

export function memoryMetadataBlockedReason(
  metadata: Readonly<Record<string, unknown>>,
  options: MemoryGovernanceOptions = {},
) {
  if (containsStructuredSecret(metadata) || containsSecretPattern(metadata)) {
    return "Memory metadata contains secret-like material.";
  }
  return !options.retainPersonalData && containsPersonalMetadata(metadata)
    ? "Memory metadata contains personal or health data."
    : undefined;
}

export function normalizeMemoryContent(content: string) {
  return content.replace(/\s+/gu, " ").trim();
}

export function memoryContentHash(content: string) {
  return createHash("sha256").update(content).digest("hex");
}

export function memoryContentMatchesHash(content: string, expectedHash: string) {
  const normalizedExpected = expectedHash
    .trim()
    .toLowerCase()
    .replace(/^sha256:/u, "");
  if (!/^[a-f0-9]{64}$/u.test(normalizedExpected)) return false;
  const actual = Buffer.from(memoryContentHash(content), "hex");
  return timingSafeEqual(actual, Buffer.from(normalizedExpected, "hex"));
}

/**
 * `retainPersonalData` is set for memories of an agent whose manifest sets
 * `memory.transcriptPrivacy: retain`: personal and health data are kept verbatim and need no
 * content review. Secret-like material is rejected either way.
 */
export interface MemoryGovernanceOptions {
  readonly retainPersonalData?: boolean;
}

export function inspectMemoryContent(
  content: string,
  options: MemoryGovernanceOptions = {},
): MemoryContentInspection {
  const normalized = normalizeMemoryContent(content);
  if (!normalized) {
    return {
      blockedReason: "Memory content is required.",
      content: normalized,
      redacted: false,
      reviewStatus: "pending",
      sensitivity: "internal",
    };
  }

  if (
    hasStructuredSecret(normalized) ||
    hasSecretAssignment(normalized) ||
    secretPatterns.some((pattern) => pattern.test(normalized))
  ) {
    return {
      blockedReason: "Memory content contains secret-like material.",
      content: normalized,
      redacted: false,
      reviewReason: "Secret-like material must not be stored as memory.",
      reviewStatus: "pending",
      sensitivity: "restricted",
    };
  }

  if (options.retainPersonalData) {
    return {
      content: normalized,
      redacted: false,
      reviewStatus: "approved",
      sensitivity: inspectMemoryContent(normalized).sensitivity,
    };
  }

  const redacted = redactPhones(normalized.replace(emailPattern, "[redacted email]"))
    .replace(ssnPattern, "[redacted ssn]")
    .replace(streetAddressPattern, "[redacted address]")
    .replace(dateOfBirthPattern, "[redacted date of birth]");
  const containsPersonalData = redacted !== normalized;
  const containsHealthData = healthPattern.test(redacted);

  if (containsPersonalData || containsHealthData) {
    return {
      content: redacted,
      redacted: containsPersonalData,
      reviewReason: containsHealthData
        ? "Possible health-related personal data requires review before recall."
        : "Potential personal data was redacted and requires review before recall.",
      reviewStatus: "pending",
      sensitivity: "restricted",
    };
  }

  return {
    content: normalized,
    redacted: false,
    reviewStatus: "approved",
    sensitivity: "internal",
  };
}

/**
 * Why stored memory content must stay out of the index and recall. A person who approved this
 * exact content in review has already made the health-data decision the inspection would defer.
 */
export function memoryRecallBlockedReason(
  memory: {
    readonly retainsPersonalData?: boolean | undefined;
    readonly reviewerApprovedContentHash?: string | undefined;
  },
  content: string,
) {
  const inspection = inspectMemoryContent(content, {
    retainPersonalData: memory.retainsPersonalData === true,
  });
  if (inspection.blockedReason) return inspection.blockedReason;
  if (inspection.redacted || inspection.content !== content) {
    return "Memory content changes under governance inspection.";
  }
  if (
    inspection.reviewStatus === "approved" ||
    memory.reviewerApprovedContentHash === memoryContentHash(content)
  ) {
    return undefined;
  }
  return inspection.reviewReason ?? "Memory content requires review before recall.";
}

/**
 * The conversation text a flush model reads to extract memories. Secret-like messages are always
 * omitted. With `omit`, so is every message holding personal or health data. With `redact`, such a
 * message keeps its text with the personal data replaced. With `retain`, it is kept as written.
 * Conversation checkpoints always use `omit`.
 */
export function sanitizeMemoryConversationContent(
  content: string,
  transcriptPrivacy: MemoryTranscriptPrivacy = "omit",
) {
  const inspection = inspectMemoryContent(content, {
    retainPersonalData: transcriptPrivacy === "retain",
  });
  if (inspection.blockedReason) return "[omitted sensitive content]";
  return transcriptPrivacy === "omit" && inspection.reviewStatus !== "approved"
    ? "[omitted sensitive content]"
    : inspection.content;
}

export function validateMemorySearchKey(value: string) {
  const normalized = value.trim();
  const inspection = inspectMemoryContent(normalized);
  if (inspection.blockedReason || inspection.redacted || inspection.reviewStatus !== "approved") {
    throw new TypeError("Memory search keys must not contain secret-like or personal data.");
  }
  if (
    normalized.length < 1 ||
    normalized.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(normalized)
  ) {
    throw new TypeError(
      "Memory search keys must contain 1 to 200 letters, numbers, dots, underscores, colons, slashes, or hyphens.",
    );
  }
  return normalized;
}

export function normalizeMemoryEntityKeys(values: readonly string[] | undefined) {
  if (!values) return undefined;
  if (values.length > 20) throw new TypeError("Memory entity keys accept at most 20 entries.");
  const normalized = values.map((value) => validateMemorySearchKey(value).toLowerCase());
  return [...new Set(normalized)];
}

export function memoryScopesForMode(mode: MemoryScope | "off"): readonly MemoryScope[] {
  if (mode === "off") return [];
  return orderedScopes.filter((scope) => scopeRank[scope] <= scopeRank[mode]);
}

export function memoryScopeAllowed(mode: MemoryScope | "off", scope: MemoryScope) {
  return memoryScopesForMode(mode).includes(scope);
}

export function shouldRunMemoryFlush(args: {
  readonly memoryMode: MemoryScope | "off";
  readonly modelTokenQuantity?: number;
  readonly recentMessageCount: number;
}) {
  if (args.memoryMode === "off") return false;
  return (
    (args.modelTokenQuantity ?? 0) >= MEMORY_FLUSH_TOKEN_THRESHOLD ||
    args.recentMessageCount >= MEMORY_FLUSH_MIN_RECENT_MESSAGES
  );
}

export interface MemoryFlushMessageSelectionItem {
  readonly consumedCharacters: number;
  readonly message: MemoryConversationMessage;
  readonly sourceCharacters: number;
}

function scalarSafePrefix(value: string, maximumCodeUnits: number) {
  let end = Math.min(value.length, Math.max(0, maximumCodeUnits));
  if (
    end > 0 &&
    end < value.length &&
    value.charCodeAt(end - 1) >= 0xd800 &&
    value.charCodeAt(end - 1) <= 0xdbff &&
    value.charCodeAt(end) >= 0xdc00 &&
    value.charCodeAt(end) <= 0xdfff
  ) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function selectMemoryFlushMessageBatch(args: {
  readonly checkpointMode?: "auto" | "off";
  readonly maximumCharacters?: number;
  readonly recentMessages: readonly MemoryConversationMessage[];
}): readonly MemoryFlushMessageSelectionItem[] {
  const selected: MemoryFlushMessageSelectionItem[] = [];
  let remaining = Math.max(
    0,
    Math.min(
      args.maximumCharacters ?? MEMORY_FLUSH_MAX_TRANSCRIPT_CHARS,
      MEMORY_FLUSH_MAX_TRANSCRIPT_CHARS,
    ),
  );
  const checkpointMode = args.checkpointMode ?? "off";
  const indexes =
    checkpointMode === "auto"
      ? Array.from({ length: args.recentMessages.length }, (_, index) => index)
      : Array.from(
          { length: args.recentMessages.length },
          (_, index) => args.recentMessages.length - index - 1,
        );
  for (const index of indexes) {
    const message = args.recentMessages[index]!;
    const separatorLength = selected.length > 0 ? 2 : 0;
    const prefixLength = conversationMessagePrefix(message).length;
    const availableContent = Math.min(
      MEMORY_FLUSH_MAX_MESSAGE_CHARS,
      remaining - separatorLength - prefixLength,
    );
    if (availableContent <= 0) break;
    const bounded = {
      ...message,
      content: scalarSafePrefix(message.content, availableContent),
    };
    if (!bounded.content) break;
    const selection = {
      consumedCharacters: bounded.content.length,
      message: bounded,
      sourceCharacters: message.content.length,
    };
    if (checkpointMode === "auto") selected.push(selection);
    else selected.unshift(selection);
    remaining -= prefixLength + bounded.content.length + separatorLength;
    if (checkpointMode === "auto" && selection.consumedCharacters < selection.sourceCharacters) {
      break;
    }
  }
  return selected;
}

export function selectMemoryFlushMessages(args: {
  readonly checkpointMode?: "auto" | "off";
  readonly maximumCharacters?: number;
  readonly recentMessages: readonly MemoryConversationMessage[];
}): readonly MemoryConversationMessage[] {
  return selectMemoryFlushMessageBatch(args).map((selection) => selection.message);
}

export function buildMemoryFlushPrompt(args: {
  readonly checkpointMessages?: readonly MemoryConversationMessage[];
  readonly checkpointMode?: "auto" | "off";
  readonly memoryMode: MemoryScope | "off";
  readonly previousCheckpoint?: string;
  readonly previousCheckpointFromCreatedAt?: string;
  readonly previousCheckpointThroughCreatedAt?: string;
  readonly recentMessages: readonly MemoryConversationMessage[];
}) {
  const checkpointMode = args.checkpointMode ?? "off";
  const checkpointMessages =
    checkpointMode === "auto"
      ? selectMemoryFlushMessages({
          checkpointMode,
          maximumCharacters:
            args.recentMessages.length > 0
              ? MEMORY_FLUSH_CHECKPOINT_TRANSCRIPT_CHARS
              : MEMORY_FLUSH_MAX_TRANSCRIPT_CHARS,
          recentMessages: args.checkpointMessages ?? args.recentMessages,
        })
      : [];
  const memoryMessages =
    args.memoryMode === "off"
      ? []
      : selectMemoryFlushMessages({
          checkpointMode: "off",
          maximumCharacters:
            checkpointMessages.length > 0
              ? MEMORY_FLUSH_CURRENT_RUN_TRANSCRIPT_CHARS
              : MEMORY_FLUSH_MAX_TRANSCRIPT_CHARS,
          recentMessages: args.recentMessages,
        });
  const transcript = (messages: readonly MemoryConversationMessage[]) =>
    messages
      .map((message) => `${conversationMessagePrefix(message)}${message.content}`)
      .join("\n\n") || "No recent messages.";
  return [
    "Extract durable memories from this deployments.ai agent conversation.",
    checkpointMode === "auto"
      ? "Return only JSON with a top-level memories array and a checkpoint string."
      : "Return only JSON with a top-level memories array.",
    "Each memory must contain content and memoryType. It may contain scope, confidence, reason, entityKeys, importance, sourceQuality, validFrom, validUntil, and supersedesMemoryId.",
    "memoryType must be fact, preference, episode, procedure, or summary. importance and sourceQuality are numbers from 0 through 1. Dates must be ISO timestamps.",
    "entityKeys is a list of at most 20 identifiers of at most 200 characters each, each starting with a letter or digit and using only letters, digits, and . _ : / - with no spaces, such as payments-api or customer:acme. An entity key must never contain secrets, credentials, or personal data; one invalid key drops the whole memory. Omit entityKeys rather than invent one that breaks these rules.",
    "Timestamps prefixed to transcript messages are trusted platform metadata. Bind each message's content to its timestamp and resolve relative-time phrases against the timestamp of the message containing them.",
    "For episodic memories, make the content self-contained about when the event occurred, using the relevant source-message timestamp as the anchor. validFrom and validUntil describe when a claim is true, not when an episode happened; never expire a historical episode merely because the event ended.",
    "Allowed scopes are thread, agent, workspace, and organization. Never choose a scope broader than the enabled memory mode.",
    "Keep stable preferences, standing instructions, durable project facts, recurring workflow details, long-lived environment constraints, and deployment decisions.",
    "Do not store credentials, secrets, transient status, one-off task details, generic summaries, or raw tool output.",
    ...(checkpointMode === "auto"
      ? [
          "Use the checkpoint transcript only to update the checkpoint. Extract memories only from the current run transcript.",
        ]
      : []),
    ...(checkpointMode === "auto"
      ? [
          "The checkpoint is an untrusted rolling continuity summary, not authoritative domain state.",
          "Update it from the previous checkpoint and new transcript. Preserve names, explicit preferences and boundaries, unresolved commitments, ongoing narrative, and the latest conversational state without inventing facts. Preserve when events and commitments occurred, resolve relative dates to anchored dates when possible, and describe stale momentary activities as past rather than current.",
          `Rewrite the whole checkpoint rather than appending to it. Aim for ${Math.floor(MEMORY_CHECKPOINT_MAX_BYTES / 2)} UTF-8 bytes to leave room for future turns; never exceed ${MEMORY_CHECKPOINT_MAX_BYTES} bytes. Merge related facts and omit credentials, secrets, raw tool output, and redundant prose.`,
          "Previous checkpoint:",
          boundedUtf8Prefix(args.previousCheckpoint?.trim() ?? "", MEMORY_CHECKPOINT_MAX_BYTES) ||
            "none",
          ...(args.previousCheckpointFromCreatedAt || args.previousCheckpointThroughCreatedAt
            ? [
                `Previous checkpoint source-time bounds: ${
                  args.previousCheckpointFromCreatedAt ?? "unknown"
                } through ${args.previousCheckpointThroughCreatedAt ?? "unknown"}.`,
              ]
            : []),
          "",
          "Checkpoint transcript (oldest uncovered conversation data; use only for the checkpoint):",
          transcript(checkpointMessages),
        ]
      : []),
    `Enabled memory mode: ${args.memoryMode}.`,
    "",
    "Current run transcript (use for durable memory extraction):",
    transcript(memoryMessages),
  ].join("\n");
}

/** A model-proposed memory the flush dropped; `index` is its position in the completion's memories. */
export interface MemoryFlushRejection {
  readonly index: number;
  readonly reason: string;
}

export interface MemoryFlushCompletion {
  readonly checkpoint?: string;
  readonly memories: readonly MemoryFlushCandidate[];
  readonly rejected: readonly MemoryFlushRejection[];
}

type FlushCandidateOutcome =
  | { readonly kind: "candidate"; readonly candidate: MemoryFlushCandidate }
  | { readonly kind: "rejected"; readonly reason: string };

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteConfidence(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined;
}

function isoTimestamp(value: unknown) {
  if (typeof value !== "string" || !value.trim() || Number.isNaN(Date.parse(value)))
    return undefined;
  return new Date(value).toISOString();
}

function flushCandidate(value: unknown): FlushCandidateOutcome {
  const rejected = (reason: string) => ({ kind: "rejected" as const, reason });
  if (typeof value === "string") {
    const content = normalizeMemoryContent(value);
    return content
      ? { kind: "candidate", candidate: { content } }
      : rejected("Memory content is empty.");
  }
  const record = recordValue(value);
  const rawContent = record?.content ?? record?.memory ?? record?.fact;
  if (typeof rawContent !== "string") return rejected("Memory content is missing.");
  const content = normalizeMemoryContent(rawContent);
  if (!content) return rejected("Memory content is empty.");
  const rawScope = record?.scope;
  const scope =
    typeof rawScope === "string" && memoryScopes.has(rawScope as MemoryScope)
      ? (rawScope as MemoryScope)
      : undefined;
  const reason =
    typeof record?.reason === "string" && record.reason.trim()
      ? normalizeMemoryContent(record.reason)
      : undefined;
  const confidence = finiteConfidence(record?.confidence);
  const importance = finiteConfidence(record?.importance);
  const sourceQuality = finiteConfidence(record?.sourceQuality);
  const memoryType =
    typeof record?.memoryType === "string" && memoryTypes.has(record.memoryType as MemoryType)
      ? (record.memoryType as MemoryType)
      : undefined;
  let entityKeys: readonly string[] | undefined;
  try {
    if (
      Array.isArray(record?.entityKeys) &&
      record.entityKeys.some((value) => typeof value !== "string")
    ) {
      return rejected("Memory entity keys must be strings.");
    }
    entityKeys = Array.isArray(record?.entityKeys)
      ? normalizeMemoryEntityKeys(record.entityKeys as string[])
      : undefined;
  } catch {
    return rejected("Memory entity keys are invalid.");
  }
  // A null bound leaves that side of the validity window open.
  const rawValidFrom = record?.validFrom ?? undefined;
  const rawValidUntil = record?.validUntil ?? undefined;
  const validFrom = isoTimestamp(rawValidFrom);
  const parsedValidUntil = isoTimestamp(rawValidUntil);
  if (rawValidFrom !== undefined && validFrom === undefined) {
    return rejected("Memory validFrom is not an ISO timestamp.");
  }
  if (rawValidUntil !== undefined && parsedValidUntil === undefined) {
    return rejected("Memory validUntil is not an ISO timestamp.");
  }
  if (validFrom && parsedValidUntil && validFrom > parsedValidUntil) {
    return rejected("Memory validUntil precedes validFrom.");
  }
  // Equal bounds mark the instant a claim became true, not an expiry, so the claim stays open-ended.
  const validUntil = parsedValidUntil === validFrom ? undefined : parsedValidUntil;
  const supersedesMemoryId =
    typeof record?.supersedesMemoryId === "string" &&
    /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u.test(record.supersedesMemoryId)
      ? record.supersedesMemoryId
      : undefined;
  return {
    kind: "candidate",
    candidate: {
      ...(confidence === undefined ? {} : { confidence }),
      content,
      ...(entityKeys?.length ? { entityKeys } : {}),
      ...(importance === undefined ? {} : { importance }),
      ...(memoryType ? { memoryType } : {}),
      ...(reason ? { reason } : {}),
      ...(scope ? { scope } : {}),
      ...(sourceQuality === undefined ? {} : { sourceQuality }),
      ...(supersedesMemoryId ? { supersedesMemoryId } : {}),
      ...(validFrom ? { validFrom } : {}),
      ...(validUntil ? { validUntil } : {}),
    },
  };
}

export function parseMemoryFlushCandidates(value: string): readonly MemoryFlushCandidate[] {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const payload = (fenced?.[1] ?? value).trim();
  if (!payload) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  const root = recordValue(parsed);
  const raw = Array.isArray(parsed)
    ? parsed
    : Array.isArray(root?.memories)
      ? root.memories
      : Array.isArray(root?.items)
        ? root.items
        : [];
  const candidates: MemoryFlushCandidate[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const outcome = flushCandidate(value);
    if (outcome.kind === "rejected") continue;
    const { candidate } = outcome;
    const key = candidate.content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
    if (candidates.length >= MEMORY_FLUSH_MAX_CANDIDATES) break;
  }
  return candidates;
}

export function parseMemoryFlushCompletion(value: string): readonly MemoryFlushCandidate[] {
  return parseMemoryFlushResult(value).memories;
}

export function parseMemoryFlushResult(value: string): MemoryFlushCompletion {
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const payload = (fenced?.[1] ?? value).trim();
  if (!payload) throw new TypeError("Memory flush completion is empty.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (cause) {
    throw new TypeError("Memory flush completion is not valid JSON.", { cause });
  }
  const root = recordValue(parsed);
  if (!root || !Array.isArray(root.memories)) {
    throw new TypeError("Memory flush completion must contain a memories array.");
  }
  const candidates: MemoryFlushCandidate[] = [];
  const rejected: MemoryFlushRejection[] = [];
  const seen = new Set<string>();
  for (const [index, value] of root.memories.entries()) {
    const outcome = flushCandidate(value);
    if (outcome.kind === "rejected") {
      rejected.push({ index, reason: outcome.reason });
      continue;
    }
    const { candidate } = outcome;
    const key = candidate.content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
    if (candidates.length >= MEMORY_FLUSH_MAX_CANDIDATES) break;
  }
  const checkpoint = typeof root.checkpoint === "string" ? root.checkpoint.trim() : undefined;
  const checkpointBytes = checkpoint ? new TextEncoder().encode(checkpoint).byteLength : 0;
  if (checkpointBytes > MEMORY_CHECKPOINT_MAX_BYTES) {
    throw new MemoryCheckpointSizeError(checkpointBytes, MEMORY_CHECKPOINT_MAX_BYTES);
  }
  return { ...(checkpoint ? { checkpoint } : {}), memories: candidates, rejected };
}

function boundedUtf8Prefix(value: string, maximumBytes: number) {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maximumBytes) return value;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const end = Math.min(encoded.byteLength, maximumBytes);
  for (let offset = 0; offset <= Math.min(3, end); offset += 1) {
    try {
      return decoder.decode(encoded.subarray(0, end - offset));
    } catch {
      // Retry before the UTF-8 code point spanning the byte boundary.
    }
  }
  return "";
}

function hashSampleFraction(hash: string) {
  const parsed = Number.parseInt(hash.slice(0, 8), 16);
  return Number.isFinite(parsed) ? parsed / 0xffffffff : 1;
}

export function memoryReviewSampled(args: {
  readonly contentHash: string;
  readonly source: string;
}) {
  const rate =
    args.source === "admin" || args.source === "api" || args.source === "import"
      ? MEMORY_IMPORT_REVIEW_SAMPLE_RATE
      : args.source === "flush"
        ? MEMORY_FLUSH_REVIEW_SAMPLE_RATE
        : 0;
  return rate > 0 && hashSampleFraction(args.contentHash) < rate;
}

function fnv1a64(value: string) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export function memoryRolloutSelected(args: {
  readonly rolloutKey?: string;
  readonly rolloutPercent?: number;
}) {
  const percent =
    args.rolloutPercent === undefined || !Number.isFinite(args.rolloutPercent)
      ? 100
      : Math.min(Math.max(Math.trunc(args.rolloutPercent), 0), 100);
  if (percent >= 100) return true;
  if (percent <= 0 || !args.rolloutKey) return false;
  return (
    hashSampleFraction(fnv1a64(normalizeMemoryContent(args.rolloutKey).toLowerCase())) <
    percent / 100
  );
}
