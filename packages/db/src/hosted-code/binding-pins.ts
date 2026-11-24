import type { AgentManifestSemanticIssue } from "@deployments-ai/agent-manifest";
import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { key } from "../keys.ts";
import { ExecutionBindingHostedCodeToolRecord } from "../records/hosted-code.ts";
import {
  RecordDecodeError,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "../records/index.ts";
import { resolveHostedCodeToolPins } from "./tool-snapshots.ts";

export type ExecutionBindingHostedCodeTool = typeof ExecutionBindingHostedCodeToolRecord.Type;

export interface ExecutionBindingHostedCodeToolKey {
  readonly executionBindingId: string;
  readonly organizationId: string;
  readonly toolName: string;
}

export interface HostedCodeBindingSnapshot {
  readonly issues: readonly AgentManifestSemanticIssue[];
  readonly pins: readonly ExecutionBindingHostedCodeTool[];
}

type ExecutionBinding = Extract<PlatformRecord, { readonly itemType: "execution-binding" }>;

export function executionBindingHostedCodeToolRecordKey(pin: ExecutionBindingHostedCodeToolKey) {
  return {
    pk: key("ORG", pin.organizationId, "EXECUTION-BINDING", pin.executionBindingId),
    sk: key("EXECUTION-BINDING-HOSTED-CODE-TOOL", pin.toolName),
  };
}

/**
 * Snapshots the hosted code tools of a manifest-sourced execution binding with the same rules as
 * release publish. The pins live exactly as long as the binding and must be written in the
 * binding's creation transaction; any issue must reject the binding. Release-sourced bindings
 * execute their release's pins and never get pins of their own.
 */
export async function snapshotExecutionBindingHostedCodeTools(
  database: DynamoDatabaseService,
  binding: ExecutionBinding,
): Promise<HostedCodeBindingSnapshot> {
  if (binding.data.source.type !== "manifest") return { issues: [], pins: [] };
  const resolution = await resolveHostedCodeToolPins(database, {
    createdAt: binding.data.createdAt,
    environmentId: binding.data.environmentId,
    manifest: binding.data.manifest,
    organizationId: binding.data.organizationId,
    ownerLabel: "An execution binding",
    projectId: binding.data.projectId,
  });
  const pins = resolution.pins.map((pin) => {
    try {
      return Schema.decodeUnknownSync(ExecutionBindingHostedCodeToolRecord, {
        onExcessProperty: "error",
      })(
        withCanonicalRecordKeys({
          data: {
            ...pin,
            executionBindingId: binding.data.id,
            expiresAt: binding.data.expiresAt,
          },
          itemType: "execution-binding-hosted-code-tool" as const,
          ttl: Math.floor(Date.parse(binding.data.expiresAt) / 1_000),
        }),
      );
    } catch (cause) {
      throw new RecordDecodeError({
        cause,
        message: "Hosted code execution binding pin is invalid.",
      });
    }
  });
  return { issues: resolution.issues, pins };
}

/**
 * Loads a binding's pin for one tool. An expired pin is never returned: DynamoDB TTL removes it
 * only asynchronously, and the binding it belongs to can no longer execute.
 */
export async function loadExecutionBindingHostedCodeTool(
  database: DynamoDatabaseService,
  pin: ExecutionBindingHostedCodeToolKey,
  at: Date,
): Promise<ExecutionBindingHostedCodeTool | undefined> {
  const record = await database.getRecord(
    "control",
    executionBindingHostedCodeToolRecordKey(pin),
    true,
  );
  if (!record) return undefined;
  if (record.itemType !== "execution-binding-hosted-code-tool") {
    throw new RecordDecodeError({
      cause: record.itemType,
      message: "Execution binding hosted code tool key contains an unexpected record.",
    });
  }
  return Date.parse(record.data.expiresAt) > at.getTime() ? record : undefined;
}
