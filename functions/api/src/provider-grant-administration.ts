import {
  PersistenceError,
  WorkspaceConnectionAuthorizationRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { providerUsesNoCredential } from "@deployments-ai/providers";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import type { AdministrationInvocation } from "./administration-api.ts";
import type { AdministrationPersistenceContext } from "./administration-persistence.ts";
import {
  activeRecordCondition,
  asObject,
  id,
  metadata,
  projection,
  recordOperations,
  strings,
  text,
} from "./administration-persistence.ts";

export function makeProviderGrantAdministration(context: AdministrationPersistenceContext) {
  const {
    dependencies,
    generateId,
    now,
    environment,
    getRecord,
    listAllRecordsConsistently,
    providers,
    write,
  } = context;

  async function createGrant(invocation: AdministrationInvocation) {
    const scope = await environment(invocation);
    const body = asObject(invocation.body);
    const workspaceId: Ulid | undefined =
      body.workspaceId === null ? undefined : id(text(body.workspaceId, "workspaceId"));
    if (workspaceId && !(await dependencies.resolveWorkspace(scope, workspaceId))) {
      throw new PersistenceError("not-found", "resource_not_found", "Workspace was not found.");
    }
    const connectionId = id(text(body.connectionId, "connectionId"));
    let providerKey: string;
    let externalAccountId: string;
    let availableScopes: readonly string[] = [];
    let usesNoCredential = false;
    const connectionConditions: TransactionOperation[] = [];
    try {
      const connection = await getRecord(invocation, "provider-connection", connectionId);
      const data = connection.data as Extract<
        PlatformRecord,
        { readonly itemType: "provider-connection" }
      >["data"];
      if (data.status !== "active") {
        throw new PersistenceError(
          "unprocessable",
          "connection_inactive",
          "Connection is not active.",
        );
      }
      connectionConditions.push(activeRecordCondition(connection));
      providerKey = data.providerKey;
      usesNoCredential = providerUsesNoCredential(providers.resolve(providerKey));
      externalAccountId = data.externalAccountId ?? data.id;
      const capabilities = await listAllRecordsConsistently(
        invocation,
        "connection-capability",
        (record) =>
          record.itemType === "connection-capability" &&
          record.data.connectionId === connectionId &&
          record.data.status === "active",
      );
      availableScopes = [
        ...new Set(
          capabilities.flatMap((capability) => {
            if (capability.itemType !== "connection-capability") return [];
            return Array.isArray(capability.data.scopes)
              ? capability.data.scopes.filter((scope): scope is string => typeof scope === "string")
              : [];
          }),
        ),
      ]
        .filter((scope) => data.scopes.includes(scope))
        .toSorted();
      if (capabilities.length === 0) {
        throw new PersistenceError(
          "unprocessable",
          "connection_not_verified",
          "Connection has no active verified capability.",
        );
      }
    } catch (cause) {
      if (
        !(cause instanceof PersistenceError) ||
        cause.kind !== "not-found" ||
        cause.code !== "resource_not_found"
      ) {
        throw cause;
      }
      const connection = await getRecord(invocation, "mcp-connection", connectionId);
      if (connection.data.status !== "active") {
        throw new PersistenceError(
          "unprocessable",
          "connection_inactive",
          "MCP connection is not active.",
        );
      }
      connectionConditions.push(activeRecordCondition(connection));
      const mcpServerId = (
        connection.data as Extract<PlatformRecord, { readonly itemType: "mcp-connection" }>["data"]
      ).mcpServerId;
      const server = (await getRecord(invocation, "mcp-server", mcpServerId)) as Extract<
        PlatformRecord,
        { readonly itemType: "mcp-server" }
      >;
      if (server.data.status !== "active") {
        throw new PersistenceError(
          "unprocessable",
          "connection_inactive",
          "MCP server is not active.",
        );
      }
      connectionConditions.push(activeRecordCondition(server));
      externalAccountId = mcpServerId;
      const extensions = await listAllRecordsConsistently(invocation, "tool-adapter", (record) => {
        if (record.itemType !== "tool-adapter" || record.data.status !== "active") return false;
        const { execution } = record.data;
        return execution.type === "mcp" && execution.mcpServerId === mcpServerId;
      });
      providerKey = "mcp";
      availableScopes = [
        ...new Set(
          extensions.flatMap((extension) => {
            if (extension.itemType !== "tool-adapter") return [];
            return Array.isArray(extension.data.requiredScopes)
              ? extension.data.requiredScopes.filter(
                  (scope): scope is string => typeof scope === "string",
                )
              : [];
          }),
        ),
      ].toSorted();
    }
    if (!workspaceId && !usesNoCredential) {
      throw new PersistenceError(
        "unprocessable",
        "environment_grant_requires_credentialless_connection",
        "Only a connection that uses no credential can be granted to every workspace.",
      );
    }
    const grantedScopes = strings(body.scopes, "scopes");
    if (grantedScopes.some((candidate) => !availableScopes.includes(candidate))) {
      throw new PersistenceError(
        "unprocessable",
        "invalid_scope",
        "Granted scopes must be a subset of connection scopes.",
      );
    }
    const constraints = metadata(body.externalResourceConstraints);
    const timestamp = now().toISOString();
    const record = Schema.decodeUnknownSync(WorkspaceConnectionAuthorizationRecord)(
      withCanonicalRecordKeys({
        itemType: "workspace-connection-authorization",
        data: {
          authorizationVersion: 1,
          connectionId,
          createdAt: timestamp,
          environmentId: scope.id,
          externalAccountId,
          externalResourceConstraints: constraints,
          id: id(await generateId()),
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          providerKey,
          purpose: text(body.purpose, "purpose"),
          resourceScopeHash: createHash("sha256")
            .update(JSON.stringify({ constraints, scopes: grantedScopes }))
            .digest("hex"),
          scopes: grantedScopes,
          status: "active",
          updatedAt: timestamp,
          version: 0,
          ...(workspaceId ? { workspaceId } : {}),
        },
      }),
    );
    if (connectionConditions.length === 0) {
      throw new PersistenceError(
        "internal",
        "persistence_error",
        "Connection authorization state could not be validated.",
      );
    }
    await write(
      invocation,
      [...connectionConditions, ...recordOperations(record, timestamp)],
      "connection-grant.create",
    );
    return projection(record);
  }
  return { createGrant };
}
