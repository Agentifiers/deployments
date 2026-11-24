import { INPUT_FILE_PROBLEM_STATUS } from "@deployments-ai/agent-manifest";
import {
  ExecutionBindingManifestNotAdmittedError,
  type ConversationError,
} from "@deployments-ai/conversations";

const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  ...INPUT_FILE_PROBLEM_STATUS,
  budget_exhausted: 429,
  deployment_unavailable: 409,
  end_user_mismatch: 409,
  execution_binding_expired: 409,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  input_artifact_unavailable: 404,
  invalid_agent_manifest: 422,
  message_too_large: 413,
  model_image_input_unknown: 422,
  model_image_input_unsupported: 422,
  not_found: 404,
  organization_standing_unavailable: 503,
  organization_suspended: 403,
  publication_barrier_lost: 409,
  publication_busy: 409,
  publication_not_reserved: 409,
  publication_released: 409,
  publication_superseded: 409,
  publication_unavailable: 409,
  release_unavailable: 409,
  response_format_conflict: 422,
  scope_mismatch: 404,
  stream_unavailable: 503,
  thread_archived: 409,
  trigger_not_allowed: 409,
  workspace_required: 422,
  workspace_unavailable: 409,
  write_conflict: 409,
};

export function conversationCodeStatus(code: string): number {
  return (
    (Object.hasOwn(STATUS_BY_CODE, code) ? STATUS_BY_CODE[code] : undefined) ??
    (code.startsWith("invalid_") ? 400 : 500)
  );
}

export function conversationErrorStatus(cause: ConversationError): number {
  if (cause instanceof ExecutionBindingManifestNotAdmittedError) return 422;
  return conversationCodeStatus(cause.code);
}
