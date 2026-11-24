import { CallbackRunContext, CallbackWorkspaceFiles } from "@deployments-ai/api-contract";
import { PersistenceError } from "@deployments-ai/db";
import { Schema } from "effect";

const decodeCallbackWorkspaceFiles = Schema.decodeUnknownSync(CallbackWorkspaceFiles);
const decodeCallbackRunContext = Schema.decodeUnknownSync(CallbackRunContext);

export function requireExtensionExecutionOptions(execution: Readonly<Record<string, unknown>>) {
  if (execution.type !== "http_callback") {
    if (execution.runContext === undefined) return;
    throw new PersistenceError(
      "unprocessable",
      "run_context_unsupported",
      "Only HTTP callback extension tools can declare execution.runContext.",
    );
  }
  if (execution.workspaceFiles !== undefined) {
    try {
      decodeCallbackWorkspaceFiles(execution.workspaceFiles);
    } catch {
      throw new PersistenceError(
        "unprocessable",
        "invalid_workspace_files",
        "execution.workspaceFiles.include must list 1-16 relative glob patterns under /workspace, each 1-256 characters without NUL or '..' segments.",
      );
    }
  }
  if (execution.runContext !== undefined) {
    try {
      decodeCallbackRunContext(execution.runContext);
    } catch {
      throw new PersistenceError(
        "unprocessable",
        "invalid_run_context",
        'execution.runContext must list distinct members of ["origin"].',
      );
    }
  }
}
