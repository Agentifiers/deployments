/**
 * Which environment-wide grants, MCP connections, and extensions apply to one agent. Connection
 * grants carry no agent field; a deployment pins them per tool in
 * `runtimeConfig.toolAuthorizations[tool].authorizationId`, which the tool-policy evaluator
 * resolves as the grant ID. MCP connections apply through a grant on them (`connectionId`) or
 * through an MCP extension the agent's tools reference (`execution.mcpServerId`).
 */

export interface PinningDeployment {
  readonly id: string;
  readonly runtimeConfig?:
    | {
        readonly toolAuthorizations?:
          | Readonly<
              Record<
                string,
                { readonly authorizationId: string; readonly toolPolicyId?: string | undefined }
              >
            >
          | undefined;
      }
    | undefined;
}

interface GrantUse {
  readonly deploymentId: string;
  readonly toolName: string;
  readonly toolPolicyId: string | undefined;
}

export interface AttributedGrant<Grant> {
  /** `undefined` when the pinned grant is not in the environment's grant list. */
  readonly grant: Grant | undefined;
  readonly grantId: string;
  readonly uses: readonly GrantUse[];
}

/** Every grant the deployments pin, in first-pinned order, with the tools that use it. */
export function attributeGrants<Grant extends { readonly id: string }>(
  deployments: readonly PinningDeployment[],
  grants: readonly Grant[],
): AttributedGrant<Grant>[] {
  const uses = new Map<string, GrantUse[]>();
  for (const deployment of deployments) {
    const pinned = deployment.runtimeConfig?.toolAuthorizations ?? {};
    for (const [toolName, binding] of Object.entries(pinned)) {
      const use = { deploymentId: deployment.id, toolName, toolPolicyId: binding.toolPolicyId };
      const existing = uses.get(binding.authorizationId);
      if (existing) existing.push(use);
      else uses.set(binding.authorizationId, [use]);
    }
  }
  const byId = new Map(grants.map((grant) => [grant.id, grant] as const));
  return [...uses].map(([grantId, grantUses]) => ({
    grant: byId.get(grantId),
    grantId,
    uses: grantUses,
  }));
}

/** Extensions whose name is one of the agent's evaluated tools. */
export function referencedExtensions<Extension extends { readonly name: string }>(
  toolNames: Iterable<string>,
  extensions: readonly Extension[],
): Extension[] {
  const names = new Set(toolNames);
  return extensions.filter((extension) => names.has(extension.name));
}

export interface AttributedMcpConnection<Connection> {
  readonly connection: Connection;
  /** Grants on this connection the agent pins. */
  readonly grantIds: readonly string[];
  /** MCP extensions the agent's tools use that this connection's server serves. */
  readonly extensionNames: readonly string[];
}

interface McpExtension {
  readonly execution: { readonly type: string; readonly mcpServerId?: string };
  readonly name: string;
}

/** MCP connections reached through a pinned grant or an MCP extension the agent references. */
export function attributeMcpConnections<
  Connection extends { readonly id: string; readonly mcpServerId: string },
>(
  connections: readonly Connection[],
  grants: readonly { readonly grantId: string; readonly connectionId: string | undefined }[],
  extensions: readonly McpExtension[],
): AttributedMcpConnection<Connection>[] {
  return connections.flatMap((connection) => {
    const grantIds = grants
      .filter((grant) => grant.connectionId === connection.id)
      .map((grant) => grant.grantId);
    const extensionNames = extensions
      .filter(
        (extension) =>
          extension.execution.type === "mcp" &&
          extension.execution.mcpServerId === connection.mcpServerId,
      )
      .map((extension) => extension.name);
    return grantIds.length > 0 || extensionNames.length > 0
      ? [{ connection, extensionNames, grantIds }]
      : [];
  });
}
