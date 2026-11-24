import { createServerFn } from "@tanstack/react-start";
import { parseChatMessage } from "../runs/chat-session.ts";
import {
  createChatThread,
  createDraftPreview,
  deletePreview,
  resolveClientToolCall,
  submitChatTurn,
  submitPreviewTurn,
} from "../server/chat-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  fields,
  keyedInput,
  requireIds,
  scopedInput,
  type KeyedInput,
  type ScopedInput,
} from "./server-input.ts";

function contentInput(input: unknown): string {
  const { content } = fields(input);
  const parsed = typeof content === "string" ? parseChatMessage(content) : undefined;
  if (!parsed?.ok) throw new TypeError(parsed?.message ?? "content must be a non-empty message.");
  return parsed.content;
}

function optionalId<const Field extends string>(input: unknown, name: Field) {
  return fields(input)[name] === undefined ? {} : requireIds(input, [name]);
}

export const createChatThreadFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly agentDeploymentId: string }) =>
    scopedInput(input, ["agentDeploymentId"]),
  )
  .handler(async ({ data }) =>
    createChatThread({ ...data, accessToken: await requireAccessToken() }),
  );

export const submitChatTurnFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: KeyedInput & {
        readonly agentDeploymentId: string;
        readonly content: string;
        readonly threadId: string;
      },
    ) => ({
      ...keyedInput(input, ["agentDeploymentId", "threadId"]),
      content: contentInput(input),
    }),
  )
  .handler(async ({ data }) =>
    submitChatTurn({ ...data, accessToken: await requireAccessToken() }),
  );

export const createDraftPreviewFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: KeyedInput & {
        readonly definitionId: string;
        readonly fromAgentDeploymentId?: string;
      },
    ) => ({
      ...keyedInput(input, ["definitionId"]),
      ...optionalId(input, "fromAgentDeploymentId"),
    }),
  )
  .handler(async ({ data }) =>
    createDraftPreview({ ...data, accessToken: await requireAccessToken() }),
  );

export const deletePreviewFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly previewId: string }) =>
    scopedInput(input, ["previewId"]),
  )
  .handler(async ({ data }) => deletePreview({ ...data, accessToken: await requireAccessToken() }));

export const submitPreviewTurnFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: KeyedInput & {
        readonly content: string;
        readonly previewId: string;
        readonly threadId?: string;
      },
    ) => ({
      ...keyedInput(input, ["previewId"]),
      ...optionalId(input, "threadId"),
      content: contentInput(input),
    }),
  )
  .handler(async ({ data }) =>
    submitPreviewTurn({ ...data, accessToken: await requireAccessToken() }),
  );

const OUTCOMES = ["completed", "failed"] as const;
const MAX_SUMMARY_LENGTH = 1_000;

export const resolveClientToolCallFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: ScopedInput & {
        readonly outcome: (typeof OUTCOMES)[number];
        readonly output?: unknown;
        readonly outputSummary?: string;
        readonly runId: string;
        readonly toolCallId: string;
      },
    ) => {
      const { outcome, output, outputSummary } = fields(input);
      if (!OUTCOMES.includes(outcome as (typeof OUTCOMES)[number])) {
        throw new TypeError("outcome must be completed or failed.");
      }
      if (
        outputSummary !== undefined &&
        (typeof outputSummary !== "string" || outputSummary.length > MAX_SUMMARY_LENGTH)
      ) {
        throw new TypeError("outputSummary must be a string of at most 1000 characters.");
      }
      return {
        ...scopedInput(input, ["runId", "toolCallId"]),
        outcome: outcome as (typeof OUTCOMES)[number],
        ...(output === undefined ? {} : { output }),
        ...(outputSummary === undefined ? {} : { outputSummary }),
      };
    },
  )
  .handler(async ({ data }) =>
    resolveClientToolCall({ ...data, accessToken: await requireAccessToken() }),
  );
