import {
  ToolAdapterRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type ToolAdapterRecordExecution,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";

import type { ToolAdapterDefinition, ToolAdapterExecution } from "./types.ts";

export function makeToolAdapterRecord(args: {
  readonly definition: ToolAdapterDefinition;
  readonly environmentId: Ulid;
  readonly id: Ulid;
  readonly occurredAt?: Date | string;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
  readonly version?: number;
}) {
  const occurredAt =
    typeof args.occurredAt === "string"
      ? args.occurredAt
      : (args.occurredAt ?? new Date()).toISOString();
  const definition = args.definition;
  const execution = definition.execution ?? { type: "builtin", adapterKey: definition.toolName };

  return Schema.decodeUnknownSync(ToolAdapterRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: occurredAt,
        defaultPolicyAction: definition.defaultPolicyAction,
        description: definition.description,
        effect: definition.effect,
        environmentId: args.environmentId,
        execution: {
          ...execution,
          authorizationScopes: [...(definition.authorizationScopes ?? [])],
          auditMetadata: definition.auditMetadata ?? null,
          defaultPolicyAction: definition.defaultPolicyAction,
          description: definition.description,
          hostPolicy: definition.hostPolicy ?? null,
          inputSchema: definition.inputSchema ?? null,
          providerOutboundMutation: definition.providerOutboundMutation ?? false,
          rateLimitPolicy: definition.rateLimitPolicy ?? null,
          resourceMetadata: definition.resourceMetadata ?? null,
          retryPolicy: definition.retryPolicy ?? null,
        },
        id: args.id,
        ...(definition.inputSchema &&
        typeof definition.inputSchema === "object" &&
        !Array.isArray(definition.inputSchema)
          ? { inputSchema: definition.inputSchema }
          : {}),
        name: definition.toolName,
        organizationId: args.organizationId,
        projectId: args.projectId,
        ...(definition.provider ? { providerKey: definition.provider } : {}),
        requiredScopes: [...(definition.requiredScopes ?? [])],
        status: definition.status === "archived" ? "archived" : "active",
        updatedAt: occurredAt,
        version: args.version ?? 1,
      },
      itemType: "tool-adapter",
    }),
  );
}

type ToolAdapter = Extract<PlatformRecord, { readonly itemType: "tool-adapter" }>;

/** Strips definition-level fields so only the routing contract of each variant remains. */
function adapterExecution(execution: ToolAdapterRecordExecution): ToolAdapterExecution {
  switch (execution.type) {
    case "builtin":
      return {
        ...(execution.adapterKey === undefined ? {} : { adapterKey: execution.adapterKey }),
        type: "builtin",
      };
    case "client":
      return {
        ...(execution.timeoutMs === undefined ? {} : { timeoutMs: execution.timeoutMs }),
        type: "client",
      };
    case "hosted_code":
      return {
        contentHash: execution.contentHash,
        entrypoint: execution.entrypoint,
        language: execution.language,
        memoryMiB: execution.memoryMiB,
        network: execution.network,
        secretNames: execution.secretNames,
        sourceLanguage: execution.sourceLanguage,
        timeoutMs: execution.timeoutMs,
        type: "hosted_code",
      };
    case "http_callback":
      return {
        completionMode: "sync",
        endpointOrigin: execution.endpointOrigin,
        endpointPath: execution.endpointPath,
        ...(execution.runContext ? { runContext: execution.runContext } : {}),
        type: "http_callback",
        // The runtime revalidates each pattern before any sandbox read.
        ...(execution.workspaceFiles
          ? { workspaceFiles: { include: execution.workspaceFiles.include } }
          : {}),
      };
    case "mcp":
      return {
        mcpServerId: execution.mcpServerId,
        remoteToolName: execution.remoteToolName,
        type: "mcp",
      };
    case "vendor_mcp":
      return {
        providerKey: execution.providerKey,
        remoteToolName: execution.remoteToolName,
        toolHash: execution.toolHash,
        type: "vendor_mcp",
      };
  }
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toolAdapterDefinitionFromRecord(record: ToolAdapter): ToolAdapterDefinition {
  const { execution } = record.data;
  const nestedAudit: unknown = execution.auditMetadata;
  const auditMetadata = {
    ...(isPlainObject(nestedAudit) ? nestedAudit : {}),
    ...(execution.type === "mcp" ? { mcpToolName: execution.remoteToolName } : {}),
    persistedAdapter: {
      id: record.data.id,
      ...(record.data.authSecretRef && "credentialId" in record.data.authSecretRef
        ? { credentialId: record.data.authSecretRef.credentialId }
        : record.data.authSecretRef
          ? { credentialArn: record.data.authSecretRef.arn }
          : {}),
      version: record.data.version,
    },
  };
  const provider =
    execution.type === "vendor_mcp" ? execution.providerKey : record.data.providerKey;
  return {
    auditMetadata,
    defaultPolicyAction: record.data.defaultPolicyAction ?? execution.defaultPolicyAction ?? "deny",
    description: record.data.description ?? execution.description ?? record.data.name,
    effect: record.data.effect,
    execution: adapterExecution(execution),
    inputSchema: record.data.inputSchema ?? execution.inputSchema,
    ...(record.data.outputSchema ? { outputSchema: record.data.outputSchema } : {}),
    ...(provider ? { provider } : {}),
    providerOutboundMutation:
      execution.type !== "client" &&
      (record.data.effect !== "read" || execution.providerOutboundMutation === true),
    requiredScopes: record.data.requiredScopes,
    status: record.data.status === "active" ? "active" : "archived",
    toolAdapterId: record.data.id,
    toolName: record.data.name,
  };
}
