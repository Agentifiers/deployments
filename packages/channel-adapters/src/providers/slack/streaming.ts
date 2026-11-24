export type SlackStreamTaskStatus = "pending" | "in_progress" | "complete" | "error";

export interface SlackMarkdownTextChunk {
  readonly text: string;
  readonly type: "markdown_text";
}

export interface SlackPlanUpdateChunk {
  readonly title: string;
  readonly type: "plan_update";
}

export interface SlackTaskUpdateChunk {
  readonly details?: string;
  readonly id: string;
  readonly status: SlackStreamTaskStatus;
  readonly title: string;
  readonly type: "task_update";
}

export type SlackStreamChunk = SlackMarkdownTextChunk | SlackPlanUpdateChunk | SlackTaskUpdateChunk;

export interface SlackStreamStartPayload {
  readonly channel: string;
  readonly chunks: readonly SlackStreamChunk[];
  readonly icon_emoji?: string;
  readonly icon_url?: string;
  readonly recipient_team_id: string;
  readonly recipient_user_id: string;
  readonly task_display_mode: "plan";
  readonly thread_ts: string;
  readonly username?: string;
}

export interface SlackStreamIdentity {
  readonly iconEmoji?: string;
  readonly iconUrl?: string;
  readonly username: string;
}

export interface SlackStreamAppendPayload {
  readonly channel: string;
  readonly chunks: readonly SlackStreamChunk[];
  readonly ts: string;
}

export interface SlackStreamStopPayload {
  readonly channel: string;
  readonly chunks: readonly SlackStreamChunk[];
  readonly ts: string;
}

export type SlackStreamUpdatePayload = {
  readonly channel: string;
  readonly ts: string;
} & ({ readonly text: string } | { readonly markdown_text: string });

const MAX_CHUNK_TEXT_CHARACTERS = 256;
/** Slack's limit on one `markdown_text` field or chunk. */
export const MAX_SLACK_MARKDOWN_TEXT_CHARACTERS = 12_000;
const MAX_TERMINAL_MARKDOWN_CHUNKS = 4;
const TERMINAL_TRUNCATION_NOTICE =
  "\n\n_Response truncated in Slack. Open Deployments.ai to view the complete result._";
const MAX_SLACK_IDENTITY_USERNAME_CHARACTERS = 80;
const MAX_SLACK_IDENTITY_ICON_EMOJI_CHARACTERS = 100;
const MAX_SLACK_IDENTITY_ICON_URL_CHARACTERS = 2_048;

function boundedText(value: unknown, fallback: string) {
  const text = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return Array.from(text).slice(0, MAX_CHUNK_TEXT_CHARACTERS).join("");
}

function boundedIdentityText(value: string, label: string, maximumCharacters: number) {
  const text = value.trim();
  if (!text) throw new TypeError(`Slack stream ${label} must not be empty.`);
  if (Array.from(text).length > maximumCharacters) {
    throw new TypeError(
      `Slack stream ${label} must not exceed ${String(maximumCharacters)} characters.`,
    );
  }
  if (
    Array.from(text).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  ) {
    throw new TypeError(`Slack stream ${label} must not contain control characters.`);
  }
  return text;
}

export function normalizeSlackStreamIdentity(value: unknown): SlackStreamIdentity | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Slack stream identity must be an object.");
  }
  const identity = value as Readonly<Record<string, unknown>>;
  if (typeof identity.username !== "string") {
    throw new TypeError("Slack stream identity username is required.");
  }
  if (identity.iconEmoji !== undefined && typeof identity.iconEmoji !== "string") {
    throw new TypeError("Slack stream identity icon emoji must be a string.");
  }
  if (identity.iconUrl !== undefined && typeof identity.iconUrl !== "string") {
    throw new TypeError("Slack stream identity icon URL must be a string.");
  }
  if (identity.iconEmoji && identity.iconUrl) {
    throw new TypeError("Slack stream identity must use at most one icon source.");
  }
  const username = boundedIdentityText(
    identity.username,
    "username",
    MAX_SLACK_IDENTITY_USERNAME_CHARACTERS,
  );
  let iconEmoji: string | undefined;
  if (identity.iconEmoji) {
    iconEmoji = boundedIdentityText(
      identity.iconEmoji,
      "icon emoji",
      MAX_SLACK_IDENTITY_ICON_EMOJI_CHARACTERS,
    );
    if (!/^:[a-z0-9_+-]+:$/u.test(iconEmoji)) {
      throw new TypeError("Slack stream icon emoji must use :emoji_name: syntax.");
    }
  }
  let iconUrl: string | undefined;
  if (identity.iconUrl) {
    iconUrl = boundedIdentityText(
      identity.iconUrl,
      "icon URL",
      MAX_SLACK_IDENTITY_ICON_URL_CHARACTERS,
    );
    let parsed: URL;
    try {
      parsed = new URL(iconUrl);
    } catch {
      throw new TypeError("Slack stream icon URL must be a valid HTTPS URL.");
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new TypeError("Slack stream icon URL must be a credential-free HTTPS URL.");
    }
    iconUrl = boundedIdentityText(parsed.href, "icon URL", MAX_SLACK_IDENTITY_ICON_URL_CHARACTERS);
  }
  return {
    ...(iconEmoji ? { iconEmoji } : {}),
    ...(iconUrl ? { iconUrl } : {}),
    username,
  };
}

export interface SlackMessageIdentityPayload {
  readonly icon_emoji?: string;
  readonly icon_url?: string;
  readonly username?: string;
}

/**
 * Maps a binding's Slack agent identity onto Slack message fields. Throws a
 * TypeError when the identity is invalid so callers never silently fall back
 * to the parent bot identity.
 */
export function slackMessageIdentityPayload(value: unknown): SlackMessageIdentityPayload {
  const identity = normalizeSlackStreamIdentity(value);
  return identity
    ? {
        ...(identity.iconEmoji ? { icon_emoji: identity.iconEmoji } : {}),
        ...(identity.iconUrl ? { icon_url: identity.iconUrl } : {}),
        username: identity.username,
      }
    : {};
}

function metadata(event: { readonly metadata?: Readonly<Record<string, unknown>> }) {
  return event.metadata ?? {};
}

function taskTitle(event: {
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}) {
  const toolName = metadata(event).toolName;
  if (typeof toolName === "string" && toolName.trim()) return `Use ${toolName.trim()}`;
  return event.message;
}

function taskId(event: {
  readonly eventType: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}) {
  const toolCallId = metadata(event).toolCallId;
  if (typeof toolCallId === "string" && toolCallId.trim()) return toolCallId.trim();
  if (event.eventType.startsWith("memory.recall.")) return "memory-recall";
  if (event.eventType.startsWith("brain.retrieval.")) return "brain-retrieval";
  if (event.eventType.startsWith("sandbox.")) return "sandbox";
  return undefined;
}

export interface SlackAgentProgress {
  readonly eventType: string;
  readonly level: "debug" | "error" | "info" | "warn";
  readonly message: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface AgentPlanTaskLike {
  readonly details?: string;
  readonly id: string;
  readonly status: "completed" | "failed" | "in_progress" | "pending" | "skipped";
  readonly title: string;
}

export function slackAgentPlanChunks(update: {
  readonly eventType: "agent.plan.updated" | "agent.task.updated";
  readonly plan: {
    readonly revision?: number;
    readonly tasks?: readonly AgentPlanTaskLike[];
    readonly title: string;
  };
  readonly task?: AgentPlanTaskLike;
}): readonly SlackStreamChunk[] {
  if (update.eventType === "agent.plan.updated") {
    return [
      { title: boundedText(update.plan.title, "Working on your request"), type: "plan_update" },
      ...(update.plan.tasks ?? []).map(
        (task): SlackTaskUpdateChunk => ({
          ...(task.details ? { details: boundedText(task.details, "Agent task updated.") } : {}),
          id: boundedText(task.id, "task"),
          status:
            task.status === "completed" || task.status === "skipped"
              ? "complete"
              : task.status === "failed"
                ? "error"
                : task.status === "in_progress"
                  ? "in_progress"
                  : "pending",
          title: boundedText(task.title, "Agent task"),
          type: "task_update",
        }),
      ),
    ];
  }
  if (!update.task) return [];
  return slackAgentPlanChunks({
    eventType: "agent.plan.updated",
    plan: { tasks: [update.task], title: update.plan.title },
  }).slice(1);
}

export function slackStreamStartPayload(input: {
  readonly channel: string;
  readonly identity?: SlackStreamIdentity;
  readonly plan?: {
    readonly tasks: readonly AgentPlanTaskLike[];
    readonly title: string;
  };
  readonly planTitle?: string;
  readonly recipientTeamId: string;
  readonly recipientUserId: string;
  readonly threadTs: string;
}): SlackStreamStartPayload {
  return {
    channel: input.channel,
    chunks: input.plan
      ? slackAgentPlanChunks({ eventType: "agent.plan.updated", plan: input.plan })
      : [
          {
            title: boundedText(input.planTitle, "Working on your request"),
            type: "plan_update",
          },
        ],
    ...slackMessageIdentityPayload(input.identity),
    recipient_team_id: input.recipientTeamId,
    recipient_user_id: input.recipientUserId,
    task_display_mode: "plan",
    thread_ts: input.threadTs,
  };
}

export function slackProgressChunks(event: SlackAgentProgress): readonly SlackStreamChunk[] {
  if (event.eventType === "tool.policy-decided") return [];
  const id = taskId(event);
  if (!id) return [];
  const completed = event.eventType.endsWith(".completed") || event.eventType === "sandbox.ready";
  const failed = event.level === "error" || event.eventType.endsWith(".failed");
  const status: SlackStreamTaskStatus = failed ? "error" : completed ? "complete" : "in_progress";
  return [
    {
      details: boundedText(event.message, "Agent progress updated."),
      id: boundedText(id, "task"),
      status,
      title: boundedText(taskTitle(event), "Agent task"),
      type: "task_update",
    },
  ];
}

export function slackTerminalChunks(input: {
  readonly body: string;
  readonly error?: string;
  readonly status: "canceled" | "completed" | "failed";
}): readonly SlackStreamChunk[] {
  if (input.status === "completed") {
    const characters = Array.from(input.body);
    const maximumCharacters = MAX_SLACK_MARKDOWN_TEXT_CHARACTERS * MAX_TERMINAL_MARKDOWN_CHUNKS;
    const truncated = characters.length > maximumCharacters;
    const visibleCharacters = truncated
      ? characters.slice(0, maximumCharacters - Array.from(TERMINAL_TRUNCATION_NOTICE).length)
      : characters;
    if (truncated) visibleCharacters.push(...Array.from(TERMINAL_TRUNCATION_NOTICE));
    return Array.from(
      { length: Math.ceil(visibleCharacters.length / MAX_SLACK_MARKDOWN_TEXT_CHARACTERS) },
      (_, index): SlackMarkdownTextChunk => ({
        text: visibleCharacters
          .slice(
            index * MAX_SLACK_MARKDOWN_TEXT_CHARACTERS,
            (index + 1) * MAX_SLACK_MARKDOWN_TEXT_CHARACTERS,
          )
          .join(""),
        type: "markdown_text",
      }),
    );
  }
  const message =
    input.error?.trim() ||
    (input.status === "canceled" ? "Agent run canceled." : "Agent run failed.");
  return [
    {
      details: boundedText(message, "Agent run ended."),
      id: "agent-run",
      status: "error",
      title: input.status === "canceled" ? "Request canceled" : "Request failed",
      type: "task_update",
    },
    { text: message, type: "markdown_text" },
  ];
}

export function slackStreamMarkdownText(chunks: readonly SlackStreamChunk[]) {
  return chunks
    .filter((chunk): chunk is SlackMarkdownTextChunk => chunk.type === "markdown_text")
    .map((chunk) => chunk.text)
    .join("");
}

/**
 * Bounds a `chat.postMessage` `markdown_text` body to Slack's 12,000-character limit, ending a
 * truncated body with the same notice the stream path uses.
 */
export function slackMarkdownMessageText(body: string) {
  const characters = Array.from(body);
  if (characters.length <= MAX_SLACK_MARKDOWN_TEXT_CHARACTERS) return body;
  return [
    ...characters.slice(
      0,
      MAX_SLACK_MARKDOWN_TEXT_CHARACTERS - Array.from(TERMINAL_TRUNCATION_NOTICE).length,
    ),
    ...Array.from(TERMINAL_TRUNCATION_NOTICE),
  ].join("");
}
