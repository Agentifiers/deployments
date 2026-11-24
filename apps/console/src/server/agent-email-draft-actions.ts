import "@tanstack/react-start/server-only";
import type { EnvironmentScope } from "../scope.ts";
import { callRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

interface DraftMutation {
  readonly accessToken: string;
  readonly draftId: string;
  readonly idempotencyKey: string;
  readonly scope: EnvironmentScope;
}

export type DraftStep = "approve" | "cancel" | "submit";

export function createDraft({
  accessToken,
  body,
  idempotencyKey,
  inboxId,
  scope,
}: Omit<DraftMutation, "draftId"> & { readonly body: unknown; readonly inboxId: string }) {
  return callRoute(
    "createAgentEmailDraft",
    {
      body: decodeRequestBody("createAgentEmailDraft", "CreateAgentEmailDraftRequest", body),
      idempotencyKey,
      path: { inboxId },
      scope,
    },
    accessToken,
  );
}

export function updateDraft({
  accessToken,
  body,
  draftId,
  idempotencyKey,
  scope,
}: DraftMutation & { readonly body: unknown }) {
  return callRoute(
    "updateAgentEmailDraft",
    {
      body: decodeRequestBody("updateAgentEmailDraft", "UpdateAgentEmailDraftRequest", body),
      idempotencyKey,
      path: { draftId },
      scope,
    },
    accessToken,
  );
}

export function stepDraft({
  accessToken,
  draftId,
  idempotencyKey,
  scope,
  step,
}: DraftMutation & { readonly step: DraftStep }) {
  const input = { idempotencyKey, path: { draftId }, scope };
  switch (step) {
    case "approve":
      return callRoute("approveAgentEmailDraft", input, accessToken);
    case "cancel":
      return callRoute("cancelAgentEmailDraft", input, accessToken);
    case "submit":
      return callRoute("submitAgentEmailDraft", input, accessToken);
  }
}

export function rejectDraft({
  accessToken,
  body,
  draftId,
  idempotencyKey,
  scope,
}: DraftMutation & { readonly body: unknown }) {
  return callRoute(
    "rejectAgentEmailDraft",
    {
      body: decodeRequestBody("rejectAgentEmailDraft", "RejectAgentEmailDraftRequest", body),
      idempotencyKey,
      path: { draftId },
      scope,
    },
    accessToken,
  );
}

export function sendDraft({ accessToken, draftId, idempotencyKey, scope }: DraftMutation) {
  return callRoute(
    "sendAgentEmailDraft",
    { idempotencyKey, path: { draftId }, scope },
    accessToken,
  );
}
