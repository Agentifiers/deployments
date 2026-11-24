import type { AgentManifestSemanticIssue, AgentManifestV1 } from "@deployments-ai/agent-manifest";
import { Effect, Schema } from "effect";
import { fromDatabase } from "../database-effect.ts";
import type { DynamoDatabaseService } from "../client-types.ts";
import { key } from "../keys.ts";
import { AgentReleaseHostedCodeToolRecord } from "../records/hosted-code.ts";
import { RecordDecodeError, withCanonicalRecordKeys } from "../records/index.ts";
import { resolveHostedCodeToolPins } from "./tool-snapshots.ts";

export type AgentReleaseHostedCodeTool = typeof AgentReleaseHostedCodeToolRecord.Type;

export interface AgentReleaseHostedCodeToolKey {
  readonly agentReleaseId: string;
  readonly organizationId: string;
  readonly toolName: string;
}

export interface HostedCodeReleaseSnapshot {
  readonly issues: readonly AgentManifestSemanticIssue[];
  readonly pins: readonly AgentReleaseHostedCodeTool[];
}

export function agentReleaseHostedCodeToolRecordKey(pin: AgentReleaseHostedCodeToolKey) {
  return {
    pk: key("ORG", pin.organizationId, "AGENT-RELEASE", pin.agentReleaseId),
    sk: key("AGENT-RELEASE-HOSTED-CODE-TOOL", pin.toolName),
  };
}

/**
 * Resolves every manifest tool that names an active hosted code adapter and snapshots its exact
 * artifact, contract, and limits for the release being published. The caller writes the returned
 * pins in the publish transaction; the semantic issues must block the publish.
 */
export async function snapshotReleaseHostedCodeTools(
  database: DynamoDatabaseService,
  input: {
    readonly agentReleaseId: string;
    readonly createdAt: string;
    readonly environmentId: string;
    readonly manifest: AgentManifestV1;
    readonly organizationId: string;
    readonly projectId: string;
  },
): Promise<HostedCodeReleaseSnapshot> {
  const resolution = await resolveHostedCodeToolPins(database, {
    ...input,
    ownerLabel: "A release",
  });
  const pins = resolution.pins.map((pin) => {
    try {
      return Schema.decodeUnknownSync(AgentReleaseHostedCodeToolRecord, {
        onExcessProperty: "error",
      })(
        withCanonicalRecordKeys({
          data: { ...pin, agentReleaseId: input.agentReleaseId },
          itemType: "agent-release-hosted-code-tool" as const,
        }),
      );
    } catch (cause) {
      throw new RecordDecodeError({ cause, message: "Hosted code release pin is invalid." });
    }
  });
  return { issues: resolution.issues, pins };
}

/**
 * Snapshots a promoted release's hosted code tools in the target environment. The promoted
 * release gets its own immutable pins resolved against the target's extensions and artifacts.
 * Promotion preserves exact code identity: every tool the source release pinned must resolve
 * there (otherwise `hosted_code_tool_unavailable`) to an artifact with the same content hash
 * (otherwise `hosted_code_tool_mismatch`).
 */
export async function snapshotPromotedReleaseHostedCodeTools(
  database: DynamoDatabaseService,
  input: Parameters<typeof snapshotReleaseHostedCodeTools>[1] & {
    readonly sourceAgentReleaseId: string;
  },
): Promise<HostedCodeReleaseSnapshot> {
  const snapshot = await snapshotReleaseHostedCodeTools(database, input);
  if (snapshot.issues.length > 0) return snapshot;
  const resolved = new Map(snapshot.pins.map((pin) => [pin.data.toolName, pin] as const));
  const sourcePins = await Effect.runPromise(
    Effect.forEach(
      input.manifest.spec.capabilities?.tools ?? [],
      (tool) =>
        fromDatabase(() =>
          loadReleaseHostedCodeTool(database, {
            agentReleaseId: input.sourceAgentReleaseId,
            organizationId: input.organizationId,
            toolName: tool.name,
          }),
        ),
      { concurrency: 16 },
    ),
  );
  const issues = sourcePins.flatMap((pin): AgentManifestSemanticIssue[] => {
    if (!pin) return [];
    const target = resolved.get(pin.data.toolName);
    if (!target) {
      return [
        {
          code: "hosted_code_tool_unavailable",
          message: `Hosted code tool ${pin.data.toolName} is not an active hosted code tool in the target environment.`,
          path: "/spec/capabilities/tools",
        },
      ];
    }
    return target.data.contentHash === pin.data.contentHash
      ? []
      : [
          {
            code: "hosted_code_tool_mismatch",
            message: `Hosted code tool ${pin.data.toolName} resolves to artifact ${target.data.contentHash} in the target environment, but the source release pinned ${pin.data.contentHash}.`,
            path: "/spec/capabilities/tools",
          },
        ];
  });
  return issues.length > 0 ? { issues, pins: [] } : snapshot;
}

export async function loadReleaseHostedCodeTool(
  database: DynamoDatabaseService,
  pin: AgentReleaseHostedCodeToolKey,
): Promise<AgentReleaseHostedCodeTool | undefined> {
  const record = await database.getRecord(
    "control",
    agentReleaseHostedCodeToolRecordKey(pin),
    true,
  );
  if (!record || record.itemType === "agent-release-hosted-code-tool") return record;
  throw new RecordDecodeError({
    cause: record.itemType,
    message: "Release hosted code tool key contains an unexpected record.",
  });
}
