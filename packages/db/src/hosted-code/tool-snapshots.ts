import {
  hostedCodeToolIssues,
  type AgentManifestSemanticIssue,
  type AgentManifestV1,
} from "@deployments-ai/agent-manifest";
import { Effect } from "effect";
import type { DatabaseError, DynamoDatabaseService } from "../client-types.ts";
import { fromDatabase } from "../database-effect.ts";
import type { AgentReleaseHostedCodeToolRecord } from "../records/hosted-code.ts";
import type { RecordDecodeError } from "../records/index.ts";
import {
  makeToolAdapterNameLookup,
  type ToolAdapterLookupScope,
} from "../tool-adapter-name-lookup.ts";
import { makeHostedCodeArtifactPersistence } from "./artifacts.ts";

/** Keeps a release publish or execution binding transaction far below DynamoDB's 100-op limit. */
export const MAX_PINNED_HOSTED_CODE_TOOLS = 32;

export type HostedCodeError = DatabaseError | RecordDecodeError;

/**
 * Undecoded pin contents shared by every pin owner. Each owner decodes these fields with its
 * identity and lifetime into its canonical pin record.
 */
export type HostedCodeToolPinContents = {
  readonly [Field in keyof Omit<
    (typeof AgentReleaseHostedCodeToolRecord.Type)["data"],
    "agentReleaseId"
  >]: unknown;
};

export interface HostedCodeToolPinResolution {
  readonly issues: readonly AgentManifestSemanticIssue[];
  readonly pins: readonly HostedCodeToolPinContents[];
}

/**
 * Resolves every manifest tool that names an active hosted code adapter and captures its exact
 * artifact, contract, and limits. Release publish and execution binding creation apply these same
 * rules; any issue must reject the write, and pins are only returned when there are none.
 */
export async function resolveHostedCodeToolPins(
  database: DynamoDatabaseService,
  input: ToolAdapterLookupScope & {
    readonly createdAt: string;
    readonly manifest: AgentManifestV1;
    /** Names the pin owner in the tool-count issue, for example "A release". */
    readonly ownerLabel: string;
  },
): Promise<HostedCodeToolPinResolution> {
  const artifacts = makeHostedCodeArtifactPersistence(database);
  const activeAdapterByName = makeToolAdapterNameLookup(database);
  const adapters = await Effect.runPromise(
    Effect.forEach(
      input.manifest.spec.capabilities?.tools ?? [],
      (tool) => fromDatabase(() => activeAdapterByName(input, tool.name)),
      { concurrency: 16 },
    ),
  );
  const hosted = adapters.flatMap((adapter) =>
    adapter?.data.execution.type === "hosted_code"
      ? [{ adapter, execution: adapter.data.execution }]
      : [],
  );
  const issues = [
    ...hostedCodeToolIssues(
      input.manifest,
      new Set(hosted.map(({ adapter }) => adapter.data.name)),
    ),
  ];
  if (hosted.length > MAX_PINNED_HOSTED_CODE_TOOLS) {
    issues.push({
      code: "too_many_hosted_code_tools",
      message: `${input.ownerLabel} can pin at most ${MAX_PINNED_HOSTED_CODE_TOOLS} hosted code tools.`,
      path: "/spec/capabilities/tools",
    });
  }
  if (issues.length > 0) return { issues, pins: [] };
  const pins: HostedCodeToolPinContents[] = [];
  for (const { adapter, execution } of hosted) {
    const artifact = await artifacts.load({
      contentHash: execution.contentHash,
      environmentId: input.environmentId,
      organizationId: input.organizationId,
    });
    if (!artifact) {
      issues.push({
        code: "hosted_code_artifact_missing",
        message: `Hosted code tool ${adapter.data.name} references an artifact that does not exist.`,
        path: "/spec/capabilities/tools",
      });
      continue;
    }
    pins.push({
      artifact: artifact.data.storage,
      contentHash: artifact.data.contentHash,
      createdAt: input.createdAt,
      effect: adapter.data.effect,
      entrypoint: execution.entrypoint,
      environmentId: adapter.data.environmentId,
      inputSchema: adapter.data.inputSchema,
      language: artifact.data.language,
      memoryMiB: execution.memoryMiB,
      network: execution.network,
      organizationId: adapter.data.organizationId,
      outputSchema: adapter.data.outputSchema,
      projectId: adapter.data.projectId,
      secretNames: execution.secretNames,
      sourceLanguage: artifact.data.sourceLanguage,
      timeoutMs: execution.timeoutMs,
      toolAdapterId: adapter.data.id,
      toolAdapterVersion: adapter.data.version,
      toolName: adapter.data.name,
      version: 0,
    });
  }
  return issues.length > 0 ? { issues, pins: [] } : { issues, pins };
}
