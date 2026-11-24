import { createServerFn } from "@tanstack/react-start";
import type { ComposeBody } from "../email/compose-state.ts";
import {
  createDraft,
  rejectDraft,
  sendDraft,
  stepDraft,
  updateDraft,
  type DraftStep,
} from "../server/agent-email-draft-actions.ts";
import {
  mintAttachmentLink,
  mintRawLink,
  reprocessMessage,
  respondToMessage,
  sendMessage,
  type ReplyMode,
} from "../server/agent-email-mailbox-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  fields,
  keyedInput,
  requireBody,
  scopedInput,
  type KeyedInput,
  type ScopedInput,
} from "./server-input.ts";

const REPLY_MODES: readonly ReplyMode[] = ["reply", "replyAll", "forward"];
const DRAFT_STEPS: readonly DraftStep[] = ["approve", "cancel", "submit"];

function oneOfField<Value extends string>(
  input: unknown,
  name: string,
  values: readonly Value[],
): Value {
  const value = fields(input)[name];
  const match = values.find((candidate) => candidate === value);
  if (match === undefined) throw new TypeError(`${name} must be one of ${values.join(", ")}.`);
  return match;
}

export const sendMessageFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly body: ComposeBody; readonly inboxId: string }) => ({
    ...keyedInput(input, ["inboxId"]),
    body: requireBody(input),
  }))
  .handler(async ({ data }) => sendMessage({ ...data, accessToken: await requireAccessToken() }));

export const respondToMessageFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: KeyedInput & {
        readonly body: ComposeBody;
        readonly messageId: string;
        readonly mode: ReplyMode;
      },
    ) => ({
      ...keyedInput(input, ["messageId"]),
      body: requireBody(input),
      mode: oneOfField(input, "mode", REPLY_MODES),
    }),
  )
  .handler(async ({ data }) =>
    respondToMessage({ ...data, accessToken: await requireAccessToken() }),
  );

export const reprocessMessageFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly messageId: string }) =>
    keyedInput(input, ["messageId"]),
  )
  .handler(async ({ data }) =>
    reprocessMessage({ ...data, accessToken: await requireAccessToken() }),
  );

export const mintRawLinkFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly messageId: string }) =>
    scopedInput(input, ["messageId"]),
  )
  .handler(async ({ data }) => mintRawLink(await requireAccessToken(), data.scope, data.messageId));

export const mintAttachmentLinkFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly attachmentId: string }) =>
    scopedInput(input, ["attachmentId"]),
  )
  .handler(async ({ data }) =>
    mintAttachmentLink(await requireAccessToken(), data.scope, data.attachmentId),
  );

export const createDraftFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly body: ComposeBody; readonly inboxId: string }) => ({
    ...keyedInput(input, ["inboxId"]),
    body: requireBody(input),
  }))
  .handler(async ({ data }) => createDraft({ ...data, accessToken: await requireAccessToken() }));

export const updateDraftFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly body: ComposeBody; readonly draftId: string }) => ({
    ...keyedInput(input, ["draftId"]),
    body: requireBody(input),
  }))
  .handler(async ({ data }) => updateDraft({ ...data, accessToken: await requireAccessToken() }));

export const stepDraftFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly draftId: string; readonly step: DraftStep }) => ({
    ...keyedInput(input, ["draftId"]),
    step: oneOfField(input, "step", DRAFT_STEPS),
  }))
  .handler(async ({ data }) => stepDraft({ ...data, accessToken: await requireAccessToken() }));

export const rejectDraftFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: KeyedInput & { readonly body: { readonly reason: string }; readonly draftId: string },
    ) => ({
      ...keyedInput(input, ["draftId"]),
      body: requireBody(input),
    }),
  )
  .handler(async ({ data }) => rejectDraft({ ...data, accessToken: await requireAccessToken() }));

export const sendDraftFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly draftId: string }) => keyedInput(input, ["draftId"]))
  .handler(async ({ data }) => sendDraft({ ...data, accessToken: await requireAccessToken() }));
