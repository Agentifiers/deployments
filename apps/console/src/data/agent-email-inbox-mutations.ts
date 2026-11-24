import type {
  CreateAgentEmailBindingRequest,
  CreateAgentEmailInboxRequest,
  UpdateAgentEmailInboxRequest,
} from "@deployments-ai/api-contract/agent-email";
import { createServerFn } from "@tanstack/react-start";
import {
  createBinding,
  createInbox,
  deleteBinding,
  updateInbox,
} from "../server/agent-email-inbox-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import { keyedInput, requireBody, type KeyedInput } from "./server-input.ts";

interface InboxInput extends KeyedInput {
  readonly inboxId: string;
}

export const createInboxFn = createServerFn({ method: "POST" })
  .validator(
    (input: KeyedInput & { readonly body: typeof CreateAgentEmailInboxRequest.Encoded }) => ({
      ...keyedInput(input),
      body: requireBody(input),
    }),
  )
  .handler(async ({ data }) => createInbox({ ...data, accessToken: await requireAccessToken() }));

export const updateInboxFn = createServerFn({ method: "POST" })
  .validator(
    (input: InboxInput & { readonly body: typeof UpdateAgentEmailInboxRequest.Encoded }) => ({
      ...keyedInput(input, ["inboxId"]),
      body: requireBody(input),
    }),
  )
  .handler(async ({ data }) => updateInbox({ ...data, accessToken: await requireAccessToken() }));

export const createBindingFn = createServerFn({ method: "POST" })
  .validator(
    (input: InboxInput & { readonly body: typeof CreateAgentEmailBindingRequest.Encoded }) => ({
      ...keyedInput(input, ["inboxId"]),
      body: requireBody(input),
    }),
  )
  .handler(async ({ data }) => createBinding({ ...data, accessToken: await requireAccessToken() }));

export const deleteBindingFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly bindingId: string }) =>
    keyedInput(input, ["bindingId"]),
  )
  .handler(async ({ data }) => deleteBinding({ ...data, accessToken: await requireAccessToken() }));
