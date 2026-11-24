import { approvalRuntimeCommands } from "./approval-runtime-commands.ts";
import { artifactRuntimeCommands } from "./artifact-runtime-commands.ts";
import { memoryRetrievalRuntimeCommands } from "./memory-retrieval-runtime-commands.ts";
import { previewCommandCatalog } from "./catalog-previews.ts";
import { workflowRuntimeCommands } from "./workflow-runtime-commands.ts";
import type { CommandCatalog } from "./types.ts";

export const runtimeCommandCatalog: CommandCatalog = {
  ...approvalRuntimeCommands,
  ...memoryRetrievalRuntimeCommands,
  ...artifactRuntimeCommands,
  ...workflowRuntimeCommands,
  ...previewCommandCatalog,
};
