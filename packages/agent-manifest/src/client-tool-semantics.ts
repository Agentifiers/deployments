import type { AgentManifestV1, AgentTrigger } from "./schema.ts";
import type { AgentManifestSemanticIssue } from "./semantics.ts";

/**
 * Triggers whose runs have no attached interactive caller able to execute a client tool and submit
 * its output: channel chat ingress, inbound email, heartbeats, schedules, webhooks, and workflows.
 */
export const AUTONOMOUS_AGENT_TRIGGERS: readonly AgentTrigger[] = [
  "chat",
  "email",
  "heartbeat",
  "schedule",
  "webhook",
  "workflow",
];

/**
 * Client-executed tools pause the run until the caller submits output, so a manifest that declares
 * one must restrict its triggers to interactive ones (an omitted trigger list allows every trigger).
 */
export function clientToolTriggerIssues(
  manifest: AgentManifestV1,
  clientToolNames: ReadonlySet<string>,
): AgentManifestSemanticIssue[] {
  const allowed = manifest.spec.triggers;
  const autonomous = AUTONOMOUS_AGENT_TRIGGERS.filter(
    (trigger) => allowed === undefined || allowed.includes(trigger),
  );
  if (autonomous.length === 0) return [];
  return (manifest.spec.capabilities?.tools ?? []).flatMap((tool, index) =>
    clientToolNames.has(tool.name)
      ? [
          {
            code: "client_tool_on_autonomous_trigger",
            message: `Client-executed tool ${tool.name} requires an interactive caller, but the manifest allows ${autonomous.join(", ")} triggers. Declare spec.triggers with only interactive triggers such as api.`,
            path: `/spec/capabilities/tools/${index}`,
          },
        ]
      : [],
  );
}
