import {
  McpConnectionRecord,
  McpServerRecord,
  PersistenceError,
  ToolAdapterRecord,
  ToolPolicyRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import { assertNoCredentialLeak, findPlatformToolAdapterDefinition } from "@deployments-ai/tools";
import { Schema } from "effect";
import type { AdministrationInvocation } from "./administration-api.ts";
import type {
  AdministrationPersistenceContext,
  AdministrationPreparedCredentialMutation,
  EnvironmentRecord,
} from "./administration-persistence.ts";
import {
  activeRecordCondition,
  asObject,
  credentialGeneration,
  expectedVersion,
  extensionInputSchema,
  id,
  metadata,
  projection,
  recordOperations,
  secretValues,
  strings,
  text,
  vaultReference,
} from "./administration-persistence.ts";
import { makeHostedCodeExtensionAdministration } from "./hosted-code-extension-administration.ts";
import { requireExtensionExecutionOptions } from "./callback-execution-options.ts";
import { assertWritableExtensionExecution } from "./extension-execution-guards.ts";

export function makeExtensionAdministration(context: AdministrationPersistenceContext) {
  const {
    dependencies,
    generateId,
    now,
    credentialValue,
    environment,
    getRecord,
    providerDefinition,
    assertScopes,
    callbackAuthorizationHeader,
    write,
  } = context;
  const prepareHostedCodeExtension = makeHostedCodeExtensionAdministration(context);

  async function createSimple(
    invocation: AdministrationInvocation,
    itemType: "mcp-connection" | "tool-adapter" | "tool-policy",
  ) {
    const scope = await environment(invocation);
    const body = asObject(invocation.body);
    const timestamp = now().toISOString();
    const common = {
      createdAt: timestamp,
      environmentId: scope.id,
      id: id(await generateId()),
      organizationId: scope.organizationId,
      projectId: scope.projectId,
      status: "active" as const,
      updatedAt: timestamp,
      version: 0,
    };
    const operations: TransactionOperation[] = [];
    let record: EnvironmentRecord;
    if (itemType === "mcp-connection") {
      const server = await getRecord(
        invocation,
        "mcp-server",
        id(text(body.mcpServerId, "mcpServerId")),
      );
      if (server.data.status !== "active") {
        throw new PersistenceError(
          "unprocessable",
          "mcp_server_inactive",
          "MCP server is not active.",
        );
      }
      operations.push(activeRecordCondition(server));
      record = Schema.decodeUnknownSync(McpConnectionRecord)(
        withCanonicalRecordKeys({
          itemType,
          data: { ...common, mcpServerId: server.data.id },
        }),
      );
    } else if (itemType === "tool-policy") {
      const policy = metadata(body.policy);
      record = Schema.decodeUnknownSync(ToolPolicyRecord)(
        withCanonicalRecordKeys({
          itemType,
          data: {
            ...common,
            name: text(body.name, "name"),
            rules: {
              ...policy,
              ...(body.description ? { description: text(body.description, "description") } : {}),
            },
          },
        }),
      );
    } else {
      const execution = metadata(body.execution);
      const inputSchema = extensionInputSchema(body.inputSchema);
      const effect = text(body.effect, "effect");
      const name = text(body.name, "name");
      if (findPlatformToolAdapterDefinition(name)) {
        throw new PersistenceError(
          "conflict",
          "tool_name_reserved",
          "Extension tool name is reserved by the built-in catalog.",
        );
      }
      assertWritableExtensionExecution(execution.type);
      requireExtensionExecutionOptions(execution);
      if (execution.type === "mcp") {
        if (effect !== "read") {
          throw new PersistenceError(
            "unprocessable",
            "mcp_effect_unsupported",
            "MCP extension tools currently support only read effects.",
          );
        }
        if (body.providerKey !== undefined) {
          throw new PersistenceError(
            "unprocessable",
            "mcp_provider_forbidden",
            "MCP extension tools cannot declare a provider key.",
          );
        }
        const server = await getRecord(
          invocation,
          "mcp-server",
          id(text(execution.mcpServerId, "execution.mcpServerId")),
        );
        const remoteToolName = text(execution.remoteToolName, "execution.remoteToolName");
        if (
          server.data.status !== "active" ||
          !(
            server.data as Extract<PlatformRecord, { readonly itemType: "mcp-server" }>["data"]
          ).toolAllowlist.includes(remoteToolName)
        ) {
          throw new PersistenceError(
            "unprocessable",
            "mcp_tool_not_allowed",
            "MCP tool is not allowed by the selected active server.",
          );
        }
        operations.push(activeRecordCondition(server));
      }
      if (execution.type === "client") {
        if (body.providerKey !== undefined || body.callbackSecret !== undefined) {
          throw new PersistenceError(
            "unprocessable",
            "client_tool_credentials_forbidden",
            "Client-executed extension tools cannot declare a provider key or callback secret.",
          );
        }
      } else if (execution.type !== "hosted_code" && body.outputSchema !== undefined) {
        throw new PersistenceError(
          "unprocessable",
          "output_schema_unsupported",
          "Only client-executed and hosted code extension tools can declare an output schema.",
        );
      }
      const hostedCode =
        execution.type === "hosted_code"
          ? await prepareHostedCodeExtension({
              adapterId: common.id,
              body,
              execution,
              scope: {
                environmentId: scope.id,
                organizationId: scope.organizationId,
                projectId: scope.projectId,
              },
            })
          : undefined;
      if (hostedCode) operations.push(...hostedCode.operations);
      const outputSchema =
        body.outputSchema === undefined ? undefined : extensionInputSchema(body.outputSchema);
      let callbackCredential: AdministrationPreparedCredentialMutation | undefined;
      if (execution.type === "http_callback") {
        if (body.providerKey === undefined) {
          throw new PersistenceError(
            "unprocessable",
            "callback_provider_required",
            "HTTP callback extensions require a provider key.",
          );
        }
        callbackCredential = await credentialValue(async () =>
          dependencies.credentials.prepareWrite({
            identity: {
              credentialId: id(await generateId()),
              environmentId: scope.id,
              organizationId: scope.organizationId,
              ownerId: common.id,
              ownerType: "tool-adapter",
              projectId: scope.projectId,
              purpose: "extension-callback-auth",
            },
            secret: {
              values: {
                authorization: callbackAuthorizationHeader(body.callbackSecret),
              },
            },
          }),
        );
        operations.push(callbackCredential.operation);
      }
      const definition =
        body.providerKey === undefined ? undefined : providerDefinition(body.providerKey);
      const requiredScopes = strings(body.requiredScopes, "requiredScopes");
      if (definition) assertScopes(requiredScopes, definition.defaultScopes, "Required scopes");
      record = Schema.decodeUnknownSync(ToolAdapterRecord)(
        withCanonicalRecordKeys({
          itemType,
          data: {
            ...common,
            ...(callbackCredential ? { authSecretRef: callbackCredential.reference } : {}),
            ...(hostedCode?.authSecretRef ? { authSecretRef: hostedCode.authSecretRef } : {}),
            defaultPolicyAction: text(body.defaultPolicyAction, "defaultPolicyAction"),
            description: text(body.description, "description"),
            effect,
            execution: hostedCode?.execution ?? execution,
            inputSchema,
            name,
            ...(outputSchema ? { outputSchema } : {}),
            ...(definition ? { providerKey: definition.key } : {}),
            requiredScopes,
          },
        }),
      );
    }
    await write(
      invocation,
      [...operations, ...recordOperations(record, timestamp)],
      `${itemType}.create`,
    );
    return projection(record);
  }

  async function createMcpServer(invocation: AdministrationInvocation) {
    const scope = await environment(invocation);
    const body = asObject(invocation.body);
    const timestamp = now().toISOString();
    const ownerId = id(await generateId());
    const prepared = body.auth
      ? await credentialValue(async () =>
          dependencies.credentials.prepareWrite({
            identity: {
              credentialId: id(await generateId()),
              environmentId: scope.id,
              organizationId: scope.organizationId,
              ownerId,
              ownerType: "mcp-server",
              projectId: scope.projectId,
              purpose: "mcp-server-auth",
            },
            secret: { values: secretValues(body.auth, "authorization") },
          }),
        )
      : undefined;
    const record = Schema.decodeUnknownSync(McpServerRecord)(
      withCanonicalRecordKeys({
        itemType: "mcp-server",
        data: {
          ...(prepared ? { authSecretRef: prepared.reference } : {}),
          createdAt: timestamp,
          endpointOrigin: text(body.endpointOrigin, "endpointOrigin"),
          endpointPath: text(body.endpointPath, "endpointPath"),
          environmentId: scope.id,
          id: ownerId,
          name: text(body.name, "name"),
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          status: "active",
          toolAllowlist: strings(body.toolAllowlist, "toolAllowlist"),
          updatedAt: timestamp,
          version: 0,
        },
      }),
    );
    await write(
      invocation,
      [...(prepared ? [prepared.operation] : []), ...recordOperations(record, timestamp)],
      "mcp-server.create",
    );
    return projection(record);
  }

  function mcpAuthorizationHeaders(values: Readonly<Record<string, string>>) {
    const authorization = values.authorization?.trim();
    const token = values.bearerToken?.trim() ?? values.apiToken?.trim();
    const unsupported = Object.keys(values).filter(
      (field) => !["apiToken", "authorization", "bearerToken"].includes(field),
    );
    if (unsupported.length > 0 || (authorization && token)) {
      throw new PersistenceError(
        "unprocessable",
        "invalid_mcp_auth",
        "MCP auth contains unsupported or conflicting fields.",
      );
    }
    const value = authorization ?? (token ? `Bearer ${token}` : undefined);
    if (
      value &&
      Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0)!;
        return codePoint <= 0x1f || codePoint === 0x7f;
      })
    ) {
      throw new PersistenceError("unprocessable", "invalid_mcp_auth", "MCP auth is invalid.");
    }
    return value ? { authorization: value } : undefined;
  }

  async function discoverMcpServer(invocation: AdministrationInvocation) {
    const server = (await getRecord(invocation, "mcp-server")) as Extract<
      PlatformRecord,
      { readonly itemType: "mcp-server" }
    >;
    if (server.data.status !== "active") {
      throw new PersistenceError(
        "unprocessable",
        "mcp_server_inactive",
        "MCP server is not active.",
      );
    }
    const secret = server.data.authSecretRef
      ? await credentialValue(() =>
          dependencies.credentials.read({
            environmentId: server.data.environmentId,
            expectedIdentity: {
              ownerId: server.data.id,
              ownerType: "mcp-server",
              projectId: server.data.projectId,
              purpose: "mcp-server-auth",
            },
            organizationId: server.data.organizationId,
            reference: vaultReference(server.data.authSecretRef),
          }),
        )
      : undefined;
    const headers = secret ? mcpAuthorizationHeaders(secret.values) : undefined;
    const tools = await dependencies.mcpDiscovery.discover({
      endpointOrigin: server.data.endpointOrigin,
      endpointPath: server.data.endpointPath,
      ...(headers ? { headers } : {}),
      toolAllowlist: server.data.toolAllowlist,
    });
    if (secret) {
      try {
        const authorizationValues = Object.values(headers ?? {}).flatMap((value) => {
          const separator = value.indexOf(" ");
          return [value, ...(separator > 0 ? [value.slice(separator + 1)] : [])];
        });
        assertNoCredentialLeak(
          JSON.stringify(tools),
          new Set([...Object.values(secret.values), ...authorizationValues]),
          tools,
        );
      } catch {
        throw new PersistenceError(
          "unprocessable",
          "mcp_discovery_credential_echo",
          "MCP discovery returned credential material.",
        );
      }
    }
    const allowed = new Set(server.data.toolAllowlist);
    if (tools.some((tool) => !allowed.has(tool.remoteName))) {
      throw new PersistenceError(
        "unprocessable",
        "mcp_discovery_mismatch",
        "MCP discovery returned a tool outside the configured allowlist.",
      );
    }
    return {
      serverId: server.data.id,
      tools,
      verifiedAt: now().toISOString(),
    };
  }

  async function updateMutable(
    invocation: AdministrationInvocation,
    itemType: "mcp-server" | "tool-adapter" | "tool-policy",
  ) {
    const previous = await getRecord(invocation, itemType);
    const body = asObject(invocation.body);
    expectedVersion(body, previous.data.version);
    const timestamp = now().toISOString();
    const changes: Record<string, unknown> = {};
    if (itemType === "tool-policy") {
      if (body.name !== undefined) changes.name = text(body.name, "name");
      if (body.policy !== undefined || body.description !== undefined) {
        const previousRules = (
          previous.data as Extract<PlatformRecord, { readonly itemType: "tool-policy" }>["data"]
        ).rules;
        const existing = Array.isArray(previousRules)
          ? { rules: previousRules }
          : metadata(previousRules);
        changes.rules = {
          ...(body.policy === undefined ? existing : metadata(body.policy)),
          ...(body.description === undefined
            ? typeof existing.description === "string"
              ? { description: existing.description }
              : {}
            : { description: text(body.description, "description") }),
        };
      }
    } else {
      for (const field of [
        "name",
        "description",
        "effect",
        "providerKey",
        "defaultPolicyAction",
      ] as const) {
        if (body[field] !== undefined) changes[field] = text(body[field], field);
      }
      if (body.execution !== undefined) changes.execution = metadata(body.execution);
      if (body.inputSchema !== undefined) {
        changes.inputSchema =
          itemType === "tool-adapter"
            ? extensionInputSchema(body.inputSchema)
            : metadata(body.inputSchema);
      }
      for (const field of ["requiredScopes", "toolAllowlist"] as const) {
        if (body[field] !== undefined) changes[field] = strings(body[field], field);
      }
      for (const field of ["endpointOrigin", "endpointPath"] as const) {
        if (body[field] !== undefined) changes[field] = text(body[field], field);
      }
    }
    const operations: TransactionOperation[] = [];
    if (itemType === "mcp-server") {
      const previousData = previous.data as Extract<
        PlatformRecord,
        { readonly itemType: "mcp-server" }
      >["data"];
      const reference = previousData.authSecretRef;
      if (
        reference &&
        ((changes.endpointOrigin !== undefined &&
          changes.endpointOrigin !== previousData.endpointOrigin) ||
          (changes.endpointPath !== undefined &&
            changes.endpointPath !== previousData.endpointPath)) &&
        body.auth === undefined
      ) {
        throw new PersistenceError(
          "unprocessable",
          "mcp_auth_replacement_required",
          "Changing an authenticated MCP server target requires replacement authentication.",
        );
      }
    }
    if (itemType === "mcp-server" && body.auth !== undefined) {
      const reference = (
        previous.data as Extract<PlatformRecord, { readonly itemType: "mcp-server" }>["data"]
      ).authSecretRef;
      const credentialReference = reference ? vaultReference(reference) : undefined;
      const generation = credentialReference
        ? credentialGeneration(credentialReference)
        : undefined;
      const prepared = await credentialValue(async () =>
        dependencies.credentials.prepareWrite({
          ...(generation === undefined ? {} : { expectedGeneration: generation }),
          identity: {
            credentialId: credentialReference?.credentialId ?? id(await generateId()),
            environmentId: previous.data.environmentId,
            organizationId: previous.data.organizationId,
            ownerId: previous.data.id,
            ownerType: "mcp-server",
            projectId: previous.data.projectId,
            purpose: "mcp-server-auth",
          },
          secret: { values: secretValues(body.auth, "authorization") },
        }),
      );
      changes.authSecretRef = prepared.reference;
      operations.push(prepared.operation);
    }
    if (itemType === "tool-adapter") {
      const previousData = previous.data as Extract<
        PlatformRecord,
        { readonly itemType: "tool-adapter" }
      >["data"];
      if (findPlatformToolAdapterDefinition(previousData.name)) {
        throw new PersistenceError(
          "conflict",
          "tool_name_reserved",
          "Extension tool name is reserved by the built-in catalog.",
        );
      }
      const execution = (changes.execution ?? previousData.execution) as Readonly<
        Record<string, unknown>
      >;
      const previousExecution = previousData.execution as Readonly<Record<string, unknown>>;
      assertWritableExtensionExecution(previousExecution.type);
      assertWritableExtensionExecution(execution.type);
      requireExtensionExecutionOptions(execution);
      if (execution.type !== previousExecution.type) {
        throw new PersistenceError(
          "unprocessable",
          "extension_execution_type_immutable",
          "Extension execution type cannot be changed.",
        );
      }
      if (execution.type === "client") {
        if ((changes.providerKey ?? previousData.providerKey) !== undefined) {
          throw new PersistenceError(
            "unprocessable",
            "client_tool_credentials_forbidden",
            "Client-executed extension tools cannot declare a provider key or callback secret.",
          );
        }
        if (body.callbackSecret !== undefined) {
          throw new PersistenceError(
            "unprocessable",
            "client_tool_credentials_forbidden",
            "Client-executed extension tools cannot declare a provider key or callback secret.",
          );
        }
        if (body.outputSchema !== undefined) {
          changes.outputSchema = extensionInputSchema(body.outputSchema);
        }
      } else if (execution.type === "hosted_code") {
        if (body.outputSchema !== undefined) {
          changes.outputSchema = extensionInputSchema(body.outputSchema);
        }
        const hostedCode = await prepareHostedCodeExtension({
          adapterId: previousData.id,
          body: { ...body, providerKey: changes.providerKey ?? previousData.providerKey },
          execution,
          previous: previousData,
          scope: previousData,
        });
        changes.execution = hostedCode.execution;
        if (hostedCode.authSecretRef) changes.authSecretRef = hostedCode.authSecretRef;
        operations.push(...hostedCode.operations);
      } else if (body.outputSchema !== undefined) {
        throw new PersistenceError(
          "unprocessable",
          "output_schema_unsupported",
          "Only client-executed and hosted code extension tools can declare an output schema.",
        );
      }
      if (execution.type !== "hosted_code" && body.secrets !== undefined) {
        throw new PersistenceError(
          "unprocessable",
          "secrets_unsupported",
          "Only hosted code extension tools can declare secrets.",
        );
      }
      if (execution.type === "mcp") {
        const effect = typeof changes.effect === "string" ? changes.effect : previousData.effect;
        if (effect !== "read") {
          throw new PersistenceError(
            "unprocessable",
            "mcp_effect_unsupported",
            "MCP extension tools currently support only read effects.",
          );
        }
        if ((changes.providerKey ?? previousData.providerKey) !== undefined) {
          throw new PersistenceError(
            "unprocessable",
            "mcp_provider_forbidden",
            "MCP extension tools cannot declare a provider key.",
          );
        }
        const server = (await getRecord(
          invocation,
          "mcp-server",
          id(text(execution.mcpServerId, "execution.mcpServerId")),
        )) as Extract<PlatformRecord, { readonly itemType: "mcp-server" }>;
        const remoteToolName = text(execution.remoteToolName, "execution.remoteToolName");
        if (
          server.data.status !== "active" ||
          !server.data.toolAllowlist.includes(remoteToolName)
        ) {
          throw new PersistenceError(
            "unprocessable",
            "mcp_tool_not_allowed",
            "MCP tool is not allowed by the selected active server.",
          );
        }
        operations.push(activeRecordCondition(server));
      }
      if (execution.type === "http_callback") {
        const reference = previousData.authSecretRef;
        if (
          reference &&
          (execution.endpointOrigin !== previousExecution.endpointOrigin ||
            execution.endpointPath !== previousExecution.endpointPath) &&
          body.callbackSecret === undefined
        ) {
          throw new PersistenceError(
            "unprocessable",
            "callback_auth_replacement_required",
            "Changing an HTTP callback target requires replacement authentication.",
          );
        }
        if (body.callbackSecret !== undefined) {
          const credentialReference = reference ? vaultReference(reference) : undefined;
          const prepared = await credentialValue(async () =>
            dependencies.credentials.prepareWrite({
              ...(credentialReference
                ? { expectedGeneration: credentialReference.generation }
                : {}),
              identity: {
                credentialId: credentialReference?.credentialId ?? id(await generateId()),
                environmentId: previousData.environmentId,
                organizationId: previousData.organizationId,
                ownerId: previousData.id,
                ownerType: "tool-adapter",
                projectId: previousData.projectId,
                purpose: "extension-callback-auth",
              },
              secret: {
                values: {
                  authorization: callbackAuthorizationHeader(body.callbackSecret),
                },
              },
            }),
          );
          changes.authSecretRef = prepared.reference;
          operations.push(prepared.operation);
        } else if (!reference) {
          throw new PersistenceError(
            "unprocessable",
            "callback_auth_required",
            "HTTP callback extensions require callback authentication.",
          );
        }
      }
      const providerKey = (changes.providerKey ?? previousData.providerKey) as string | undefined;
      const requiredScopes = (changes.requiredScopes ??
        previousData.requiredScopes) as readonly string[];
      if (providerKey) {
        assertScopes(
          requiredScopes,
          providerDefinition(providerKey).defaultScopes,
          "Required scopes",
        );
      }
    }
    const rawNext = withCanonicalRecordKeys({
      itemType,
      data: {
        ...previous.data,
        ...changes,
        updatedAt: timestamp,
        version: previous.data.version + 1,
      },
    });
    const next = (
      itemType === "mcp-server"
        ? Schema.decodeUnknownSync(McpServerRecord)(rawNext)
        : itemType === "tool-policy"
          ? Schema.decodeUnknownSync(ToolPolicyRecord)(rawNext)
          : Schema.decodeUnknownSync(ToolAdapterRecord)(rawNext)
    ) as EnvironmentRecord;
    operations.push(...recordOperations(next, timestamp, previous));
    await write(invocation, operations, `${itemType}.update`);
    return projection(next);
  }
  return {
    createSimple,
    createMcpServer,
    mcpAuthorizationHeaders,
    discoverMcpServer,
    updateMutable,
  };
}
