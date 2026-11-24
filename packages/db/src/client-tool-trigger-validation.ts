import { clientToolTriggerIssues, type AgentManifestV1 } from "@deployments-ai/agent-manifest";
import type { DynamoDatabaseService } from "./client-types.ts";
import { PersistenceError } from "./persistence-types.ts";
import {
  makeToolAdapterNameLookup,
  type ToolAdapterLookupScope,
} from "./tool-adapter-name-lookup.ts";

/**
 * Rejects releases and deployments whose manifest binds a client-executed extension tool while
 * allowing triggers that have no interactive caller to run it.
 */
export async function assertClientToolTriggers(
  database: DynamoDatabaseService,
  scope: ToolAdapterLookupScope,
  manifest: AgentManifestV1,
): Promise<void> {
  const activeAdapterByName = makeToolAdapterNameLookup(database);
  const toolNames = [
    ...new Set((manifest.spec.capabilities?.tools ?? []).map((tool) => tool.name)),
  ];
  const clientTools = await Promise.all(
    toolNames.map(async (name) =>
      (await activeAdapterByName(scope, name))?.data.execution.type === "client" ? name : [],
    ),
  );
  const issues = clientToolTriggerIssues(manifest, new Set(clientTools.flat()));
  if (issues.length > 0) {
    throw new PersistenceError(
      "unprocessable",
      "client_tool_on_autonomous_trigger",
      issues.map((issue) => `${issue.path}: ${issue.message}`).join(" "),
    );
  }
}
