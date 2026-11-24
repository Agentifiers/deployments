import { PersistenceError, ToolAdapterRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import type { PlatformRecord } from "@deployments-ai/db";
import { RemoteMcpError } from "@deployments-ai/mcp-client";
import type { RemoteMcpAllToolsDiscoveryResult } from "@deployments-ai/mcp-client";
import { vendorMcpToolEffect } from "@deployments-ai/providers";
import type { ProviderDefinition } from "@deployments-ai/providers";
import { assertNoCredentialLeak } from "@deployments-ai/tools";
import { Option, Schema } from "effect";
import type { AdministrationInvocation } from "./administration-api.ts";
import type { AdministrationPersistenceContext } from "./administration-persistence.ts";
import { id, recordOperations, resourceId } from "./administration-persistence.ts";
import { VENDOR_MCP_DISCOVERY_TIMEOUT_MS } from "./provider-verification-mcp.ts";
import {
  VendorMcpAdministrationError,
  requireVendorMcpDependencies,
} from "./vendor-mcp-administration-errors.ts";
import {
  readVendorMcpConnectionCredential,
  type ProviderConnection,
} from "./vendor-mcp-connection-credential.ts";
import {
  planVendorMcpToolSync,
  type VendorMcpDesiredTool,
  type VendorMcpToolSyncChange,
} from "./vendor-mcp-tool-sync-plan.ts";

type ToolAdapter = Extract<PlatformRecord, { readonly itemType: "tool-adapter" }>;

/** Per-tool record construction; a tool the record schema cannot hold is rejected alone. */
const decodeAdapter = Schema.decodeUnknownOption(ToolAdapterRecord);

function syncedFieldsChanged(adapter: ToolAdapter, tool: VendorMcpDesiredTool): boolean {
  const { execution } = adapter.data;
  return (
    execution.type !== "vendor_mcp" ||
    execution.toolHash !== tool.toolHash ||
    adapter.data.name !== tool.toolName ||
    adapter.data.effect !== tool.effect ||
    adapter.data.description !== tool.description ||
    adapter.data.defaultPolicyAction !== tool.defaultPolicyAction ||
    adapter.data.providerKey !== execution.providerKey ||
    adapter.data.requiredScopes.join("\u0000") !== tool.requiredScopes.join("\u0000")
  );
}

function discoveryFailure(cause: unknown): Error {
  if (
    cause instanceof RemoteMcpError &&
    cause.code === "http" &&
    (cause.statusCode === 401 || cause.statusCode === 403)
  ) {
    return new PersistenceError(
      "conflict",
      "connection_reauthorization_required",
      "The vendor MCP server rejected the connection credential.",
    );
  }
  return new VendorMcpAdministrationError(
    502,
    "mcp_discovery_failed",
    "Vendor MCP tool discovery failed.",
  );
}

/**
 * `POST /v1/connections/:connectionId/tools/sync`: lists the vendor server's tools with the
 * connection credential and reconciles the environment's tenant tool adapters for that
 * provider. Each adapter change commits in its own transaction through the standard record
 * operations, so unique name claims and audit/semantic events match extension writes.
 */
export function makeVendorMcpToolSync(context: AdministrationPersistenceContext) {
  const { generateId, getRecord, listAllRecordsConsistently, now, providerDefinition, write } =
    context;

  async function activeCapability(invocation: AdministrationInvocation, connectionId: string) {
    const capabilities = await listAllRecordsConsistently(
      invocation,
      "connection-capability",
      (record) =>
        record.itemType === "connection-capability" &&
        record.data.connectionId === connectionId &&
        record.data.status === "active",
    );
    return capabilities.length > 0;
  }

  async function discover(
    invocation: AdministrationInvocation,
    connection: ProviderConnection,
  ): Promise<RemoteMcpAllToolsDiscoveryResult> {
    const { mcpClient } = requireVendorMcpDependencies(context.dependencies);
    const credential = await readVendorMcpConnectionCredential(context, invocation, connection);
    let discovered: RemoteMcpAllToolsDiscoveryResult;
    try {
      discovered = await mcpClient.discoverAllTools({
        endpointOrigin: credential.endpointOrigin,
        endpointPath: credential.endpointPath,
        headers: credential.headers,
        timeoutMs: VENDOR_MCP_DISCOVERY_TIMEOUT_MS,
      });
    } catch (cause) {
      throw discoveryFailure(cause);
    }
    try {
      assertNoCredentialLeak(JSON.stringify(discovered), credential.sensitiveMaterials, discovered);
    } catch {
      throw new VendorMcpAdministrationError(
        502,
        "mcp_discovery_credential_echo",
        "Vendor MCP discovery returned credential material.",
      );
    }
    return discovered;
  }

  /** Creates the adapter unless its name claim is held elsewhere or the record is invalid. */
  async function createAdapter(
    invocation: AdministrationInvocation,
    connection: ProviderConnection,
    definition: ProviderDefinition,
    tool: VendorMcpDesiredTool,
    timestamp: string,
  ): Promise<"created" | "name_collision" | "record_unrepresentable"> {
    const record = decodeAdapter(
      withCanonicalRecordKeys({
        itemType: "tool-adapter",
        data: {
          ...adapterContent(definition, tool),
          createdAt: timestamp,
          environmentId: connection.data.environmentId,
          id: id(await generateId()),
          organizationId: connection.data.organizationId,
          projectId: connection.data.projectId,
          status: "active",
          updatedAt: timestamp,
          version: 0,
        },
      }),
    );
    if (Option.isNone(record)) return "record_unrepresentable";
    try {
      await write(invocation, recordOperations(record.value, timestamp), "tool-adapter.create");
    } catch (cause) {
      if (cause instanceof PersistenceError && cause.kind === "conflict") return "name_collision";
      throw cause;
    }
    return "created";
  }

  async function replaceAdapter(
    invocation: AdministrationInvocation,
    previous: ToolAdapter,
    data: Readonly<Record<string, unknown>>,
    operation: string,
    timestamp: string,
  ): Promise<boolean> {
    const next = decodeAdapter(
      withCanonicalRecordKeys({
        itemType: "tool-adapter",
        data: {
          ...previous.data,
          ...data,
          updatedAt: timestamp,
          version: previous.data.version + 1,
        },
      }),
    );
    if (Option.isNone(next)) return false;
    await write(invocation, recordOperations(next.value, timestamp, previous), operation);
    return true;
  }

  async function syncConnectionTools(invocation: AdministrationInvocation) {
    const connection = (await getRecord(
      invocation,
      "provider-connection",
      resourceId(invocation, "connectionId"),
    )) as ProviderConnection;
    const definition = providerDefinition(connection.data.providerKey);
    if (definition.route !== "vendor_mcp") {
      throw new PersistenceError(
        "unprocessable",
        "connection_not_vendor_mcp",
        "The connection does not belong to a vendor-hosted MCP provider.",
      );
    }
    if (
      connection.data.status !== "active" ||
      !connection.data.credentialRef ||
      !(await activeCapability(invocation, connection.data.id))
    ) {
      throw new PersistenceError(
        "unprocessable",
        "connection_not_verified",
        "Tool sync requires an active, verified vendor MCP connection.",
      );
    }
    const discovered = await discover(invocation, connection);
    const plan = planVendorMcpToolSync(definition, discovered.tools);
    const adapters = (await listAllRecordsConsistently(
      invocation,
      "tool-adapter",
      (record) => record.itemType === "tool-adapter" && record.data.status === "active",
    )) as ToolAdapter[];
    const owned = new Map<string, ToolAdapter>();
    const foreignNames = new Set<string>();
    const duplicates: { readonly adapter: ToolAdapter; readonly remoteName: string }[] = [];
    for (const adapter of adapters) {
      const { execution } = adapter.data;
      if (execution.type !== "vendor_mcp" || execution.providerKey !== definition.key) {
        foreignNames.add(adapter.data.name);
      } else if (owned.has(execution.remoteToolName)) {
        duplicates.push({ adapter, remoteName: execution.remoteToolName });
      } else {
        owned.set(execution.remoteToolName, adapter);
      }
    }
    const timestamp = now().toISOString();
    const changes: VendorMcpToolSyncChange[] = [...plan.rejected];
    const advertised = new Set(plan.desired.map((tool) => tool.remoteName));
    const stale = [
      ...duplicates,
      ...[...owned].flatMap(([remoteName, adapter]) =>
        advertised.has(remoteName) ? [] : [{ adapter, remoteName }],
      ),
    ];
    // Archive first so a renamed remote tool can reclaim its released platform name.
    for (const { adapter, remoteName } of stale) {
      const archived = await replaceAdapter(
        invocation,
        adapter,
        { status: "archived" },
        "tool-adapter.status",
        timestamp,
      );
      changes.push({
        ...vendorMcpToolEffect(definition, remoteName),
        remoteName,
        toolName: adapter.data.name,
        ...(archived
          ? { change: "archived" as const }
          : { change: "rejected" as const, reason: "record_unrepresentable" }),
      });
    }
    for (const tool of plan.desired) {
      const summary = {
        classified: tool.classified,
        destructive: tool.destructive,
        effect: tool.effect,
        remoteName: tool.remoteName,
        toolName: tool.toolName,
      };
      const existing = owned.get(tool.remoteName);
      if (!existing) {
        const outcome = foreignNames.has(tool.toolName)
          ? "name_collision"
          : await createAdapter(invocation, connection, definition, tool, timestamp);
        changes.push(
          outcome === "created"
            ? { ...summary, change: "created" }
            : { ...summary, change: "rejected", reason: outcome },
        );
      } else if (syncedFieldsChanged(existing, tool)) {
        const updated = await replaceAdapter(
          invocation,
          existing,
          adapterContent(definition, tool),
          "tool-adapter.update",
          timestamp,
        );
        changes.push(
          updated
            ? { ...summary, change: "updated" }
            : { ...summary, change: "rejected", reason: "record_unrepresentable" },
        );
      } else {
        changes.push({ ...summary, change: "unchanged" });
      }
    }
    return {
      connectionId: connection.data.id,
      providerKey: definition.key,
      syncedAt: timestamp,
      tools: changes.toSorted((left, right) => {
        const leftKey = left.toolName ?? left.remoteName;
        const rightKey = right.toolName ?? right.remoteName;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      }),
    };
  }

  return { syncConnectionTools };
}

function adapterContent(definition: ProviderDefinition, tool: VendorMcpDesiredTool) {
  return {
    defaultPolicyAction: tool.defaultPolicyAction,
    description: tool.description,
    effect: tool.effect,
    execution: {
      providerKey: definition.key,
      remoteToolName: tool.remoteName,
      toolHash: tool.toolHash,
      type: "vendor_mcp",
    },
    inputSchema: tool.inputSchema,
    name: tool.toolName,
    providerKey: definition.key,
    requiredScopes: [...tool.requiredScopes],
  };
}
