import type { RuntimeToolExecutionResult } from "@deployments-ai/agent-runtime";
import type { AppsDatabaseErrorCode } from "@deployments-ai/app-database/protocol";

export type AppToolRefusalCode =
  | AppsDatabaseErrorCode
  | "agent_definition_required"
  | "app_not_found"
  | "app_not_ready"
  | "apps_database_unavailable"
  | "approval_required"
  | "invalid_publication"
  | "invalid_slug"
  | "release_invalid"
  | "release_not_found"
  | "release_upload_failed"
  | "sandbox_required"
  | "slug_taken"
  | "workspace_required";

export class AppToolRefusal extends Error {
  override readonly name = "AppToolRefusal";

  constructor(
    readonly code: AppToolRefusalCode,
    message: string,
    readonly statement?: string,
  ) {
    super(message);
  }
}

export function appToolRefusalResult(
  toolName: string,
  refusal: AppToolRefusal,
): RuntimeToolExecutionResult {
  return {
    output: {
      error: {
        code: refusal.code,
        message: refusal.message,
        ...(refusal.statement === undefined ? {} : { statement: refusal.statement }),
      },
    },
    outputSummary: `${toolName} failed: ${refusal.message}`,
    status: "completed",
  };
}
