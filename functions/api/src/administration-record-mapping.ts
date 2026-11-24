import { PersistenceError, Ulid } from "@deployments-ai/db";

import { metadata, type EnvironmentRecord } from "./administration-persistence-contracts.ts";
export function projection(record: EnvironmentRecord): Readonly<Record<string, unknown>> {
  const data = record.data as Readonly<Record<string, unknown>>;
  switch (record.itemType) {
    case "provider-application":
      return {
        clientId: data.clientId,
        createdAt: data.createdAt,
        displayName: data.displayName,
        hasClientSecret: data.clientSecretRef !== undefined,
        id: data.id,
        ...(data.metadata === undefined ? {} : { metadata: data.metadata }),
        providerKey: data.providerKey,
        redirectUris: data.redirectUris,
        requestedScopes: data.requestedScopes,
        status: data.status,
        updatedAt: data.updatedAt,
        version: data.version,
      };
    case "provider-connection": {
      const display = metadata(data.displayMetadata);
      return {
        authMethod: data.authMethod,
        createdAt: data.createdAt,
        displayName:
          typeof display.displayName === "string" ? display.displayName : data.providerKey,
        ...(data.externalAccountId === undefined
          ? {}
          : { externalAccountId: data.externalAccountId }),
        ...(data.externalAccountName === undefined
          ? {}
          : { externalAccountName: data.externalAccountName }),
        hasCredential: data.credentialRef !== undefined,
        id: data.id,
        ...(data.lastVerifiedAt === undefined ? {} : { lastVerifiedAt: data.lastVerifiedAt }),
        ...(data.providerApplicationId === undefined
          ? {}
          : { providerApplicationId: data.providerApplicationId }),
        providerKey: data.providerKey,
        ...(data.refreshAfter === undefined ? {} : { refreshAfter: data.refreshAfter }),
        scopes: data.scopes,
        status: data.status,
        updatedAt: data.updatedAt,
        version: data.version,
      };
    }
    case "connection-verification":
      return {
        ...(data.completedAt === undefined ? {} : { completedAt: data.completedAt }),
        connectionId: data.connectionId,
        createdAt: data.createdAt,
        ...(data.error === undefined ? {} : { error: data.error }),
        id: data.id,
        providerKey: data.providerKey,
        ...(data.result === undefined ? {} : { result: data.result }),
        status: data.status,
        updatedAt: data.updatedAt,
        version: data.version,
      };
    case "connection-capability":
      return {
        connectionId: data.connectionId,
        id: data.id,
        ...(data.metadata === undefined ? {} : { metadata: data.metadata }),
        providerKey: data.providerKey,
        scopes: data.scopes,
        status: data.status,
        verificationVersion: data.verificationVersion,
      };
    case "workspace-connection-authorization":
      return {
        authorizationVersion: data.authorizationVersion,
        connectionId: data.connectionId,
        createdAt: data.createdAt,
        externalAccountId: data.externalAccountId,
        externalResourceConstraints: data.externalResourceConstraints,
        id: data.id,
        providerKey: data.providerKey,
        purpose: data.purpose,
        scopes: data.scopes ?? [],
        status: data.status,
        updatedAt: data.updatedAt,
        version: data.version,
        workspaceId: data.workspaceId ?? null,
      };
    case "mcp-server":
      return {
        createdAt: data.createdAt,
        endpointOrigin: data.endpointOrigin,
        endpointPath: data.endpointPath,
        hasAuth: data.authSecretRef !== undefined,
        id: data.id,
        name: data.name,
        status: data.status,
        toolAllowlist: data.toolAllowlist,
        updatedAt: data.updatedAt,
        version: data.version,
      };
    case "mcp-connection":
      return {
        createdAt: data.createdAt,
        id: data.id,
        mcpServerId: data.mcpServerId,
        status: data.status,
        updatedAt: data.updatedAt,
        version: data.version,
      };
    case "tool-policy": {
      const policy = Array.isArray(data.rules) ? {} : metadata(data.rules);
      return {
        createdAt: data.createdAt,
        ...(typeof policy.description === "string" ? { description: policy.description } : {}),
        id: data.id,
        name: data.name,
        policy: {
          ...(typeof policy.defaultAction === "string"
            ? { defaultAction: policy.defaultAction }
            : {}),
          ...(typeof policy.defaultReason === "string"
            ? { defaultReason: policy.defaultReason }
            : {}),
          rules: Array.isArray(policy.rules)
            ? policy.rules
            : Array.isArray(data.rules)
              ? data.rules
              : [],
        },
        status: data.status,
        updatedAt: data.updatedAt,
        version: data.version,
      };
    }
    case "tool-adapter":
      return {
        createdAt: data.createdAt,
        defaultPolicyAction: data.defaultPolicyAction,
        description: data.description,
        effect: data.effect,
        execution: data.execution,
        hasCallbackAuth:
          data.authSecretRef !== undefined &&
          (data.execution as Readonly<Record<string, unknown>>).type === "http_callback",
        id: data.id,
        inputSchema: data.inputSchema,
        name: data.name,
        ...(data.outputSchema === undefined ? {} : { outputSchema: data.outputSchema }),
        ...(data.providerKey === undefined ? {} : { providerKey: data.providerKey }),
        requiredScopes: data.requiredScopes,
        status: data.status,
        updatedAt: data.updatedAt,
        version: data.version,
      };
  }
}

export function encodeCursor(
  value: Readonly<Record<string, unknown>>,
  environmentId: Ulid,
  itemType: string,
) {
  return Buffer.from(JSON.stringify({ environmentId, itemType, key: value, version: 1 })).toString(
    "base64url",
  );
}

export function decodeCursor(
  value: string | undefined,
  environmentId: Ulid,
  itemType: string,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
      environmentId?: unknown;
      itemType?: unknown;
      key?: unknown;
      version?: unknown;
    };
    if (
      decoded.version !== 1 ||
      decoded.environmentId !== environmentId ||
      decoded.itemType !== itemType ||
      !decoded.key ||
      typeof decoded.key !== "object" ||
      Array.isArray(decoded.key)
    ) {
      throw new Error("invalid cursor");
    }
    const cursorKey = decoded.key as Record<string, unknown>;
    if (
      itemType !== "provider-definition" &&
      ["pk", "sk", "gsi2pk", "gsi2sk"].some(
        (field) => typeof cursorKey[field] !== "string" || cursorKey[field] === "",
      )
    ) {
      throw new Error("invalid cursor key");
    }
    return cursorKey;
  } catch {
    throw new PersistenceError(
      "invalid-input",
      "invalid_cursor",
      "The pagination cursor is invalid.",
    );
  }
}
