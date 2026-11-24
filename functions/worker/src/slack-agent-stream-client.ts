import type {
  SlackStreamAppendPayload,
  SlackStreamStartPayload,
  SlackStreamStopPayload,
  SlackStreamUpdatePayload,
} from "@deployments-ai/channel-adapters/slack";

const SLACK_STREAM_REQUEST_TIMEOUT_MS = 10_000;

export interface SlackAgentStreamClient {
  readonly append: (token: string, payload: SlackStreamAppendPayload) => Promise<void>;
  readonly start: (
    token: string,
    payload: SlackStreamStartPayload,
  ) => Promise<{ readonly ts: string }>;
  readonly stop: (token: string, payload: SlackStreamStopPayload) => Promise<void>;
  readonly update: (token: string, payload: SlackStreamUpdatePayload) => Promise<void>;
}

export class SlackAgentStreamApiError extends Error {
  readonly code?: string;
  readonly status: number;
  readonly safeToFallback: boolean;

  constructor(method: string, status: number, code?: string) {
    super(`Slack ${method} failed${code ? `: ${code}` : ` with HTTP ${status}`}.`);
    this.name = "SlackAgentStreamApiError";
    if (code) this.code = code;
    this.status = status;
    const ambiguousCodes = [
      "fatal_error",
      "internal_error",
      "missing_ts",
      "request_timeout",
      "service_unavailable",
    ];
    this.safeToFallback =
      Boolean(code) &&
      status < 500 &&
      !ambiguousCodes.includes(code ?? "") &&
      (method === "chat.startStream" || code === "message_not_found");
  }
}

async function slackApi(method: string, token: string, payload: unknown) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    body: JSON.stringify(payload),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(SLACK_STREAM_REQUEST_TIMEOUT_MS),
  });
  let body: { readonly error?: string; readonly ok?: boolean; readonly ts?: string };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new SlackAgentStreamApiError(method, response.status);
  }
  if (!response.ok || body.ok !== true) {
    throw new SlackAgentStreamApiError(method, response.status, body.error);
  }
  return body;
}

export const slackAgentStreamClient: SlackAgentStreamClient = {
  append: async (token, payload) => void (await slackApi("chat.appendStream", token, payload)),
  start: async (token, payload) => {
    const body = await slackApi("chat.startStream", token, payload);
    if (!body.ts?.trim()) {
      throw new SlackAgentStreamApiError("chat.startStream", 200, "missing_ts");
    }
    return { ts: body.ts.trim() };
  },
  stop: async (token, payload) => void (await slackApi("chat.stopStream", token, payload)),
  update: async (token, payload) => void (await slackApi("chat.update", token, payload)),
};
