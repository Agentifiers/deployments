import "@tanstack/react-start/server-only";
import { forwardParts } from "../email/compose-state.ts";
import type { PresignedUrl } from "../presigned.ts";
import type { EnvironmentScope } from "../scope.ts";
import { callRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

interface Mutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly scope: EnvironmentScope;
}

interface MessageMutation extends Mutation {
  readonly body: unknown;
  readonly messageId: string;
}

export type ReplyMode = "reply" | "replyAll" | "forward";

export function sendMessage({
  accessToken,
  body,
  idempotencyKey,
  inboxId,
  scope,
}: Mutation & { readonly body: unknown; readonly inboxId: string }) {
  return callRoute(
    "sendAgentEmailMessage",
    {
      body: decodeRequestBody("sendAgentEmailMessage", "SendAgentEmailMessageRequest", body),
      idempotencyKey,
      path: { inboxId },
      scope,
    },
    accessToken,
  );
}

export async function respondToMessage({
  accessToken,
  body,
  idempotencyKey,
  messageId,
  mode,
  scope,
}: MessageMutation & { readonly mode: ReplyMode }) {
  const path = { messageId };
  switch (mode) {
    case "reply":
      return callRoute(
        "replyToAgentEmailMessage",
        {
          body: decodeRequestBody("replyToAgentEmailMessage", "AgentEmailReplyRequest", body),
          idempotencyKey,
          path,
          scope,
        },
        accessToken,
      );
    case "replyAll":
      return callRoute(
        "replyAllToAgentEmailMessage",
        {
          body: decodeRequestBody("replyAllToAgentEmailMessage", "AgentEmailReplyRequest", body),
          idempotencyKey,
          path,
          scope,
        },
        accessToken,
      );
    case "forward": {
      const request = decodeRequestBody(
        "forwardAgentEmailMessage",
        "AgentEmailForwardRequest",
        body,
      );
      const parts =
        request.includeOriginal !== false && request.text !== undefined
          ? forwardParts(
              request.text,
              await callRoute("getAgentEmailMessage", { path, scope }, accessToken),
            )
          : {};
      return callRoute(
        "forwardAgentEmailMessage",
        { body: { ...request, ...parts }, idempotencyKey, path, scope },
        accessToken,
      );
    }
  }
}

export function reprocessMessage({
  accessToken,
  idempotencyKey,
  messageId,
  scope,
}: Mutation & { readonly messageId: string }) {
  return callRoute(
    "reprocessAgentEmailMessage",
    { idempotencyKey, path: { messageId }, scope },
    accessToken,
  );
}

export async function mintRawLink(
  accessToken: string,
  scope: EnvironmentScope,
  messageId: string,
): Promise<PresignedUrl> {
  const { expiresAt, url } = await callRoute(
    "createAgentEmailRawAccessUrl",
    { path: { messageId }, scope },
    accessToken,
  );
  return { expiresAt, url };
}

export async function mintAttachmentLink(
  accessToken: string,
  scope: EnvironmentScope,
  attachmentId: string,
): Promise<PresignedUrl> {
  const { expiresAt, url } = await callRoute(
    "createAgentEmailAttachmentAccessUrl",
    { path: { attachmentId }, scope },
    accessToken,
  );
  return { expiresAt, url };
}
