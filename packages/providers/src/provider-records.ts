import { ProviderDefinitionRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { Schema } from "effect";

import type { ProviderDefinition, ProviderRoute } from "./provider-definitions.ts";
import { providerDefinitionCodeVersion } from "./provider-registry.ts";

function recordRoute(route: ProviderRoute) {
  if (route === "platform_oauth") return "oauth" as const;
  if (route === "platform_api_credential") return "static" as const;
  if (route === "mcp_gateway" || route === "vendor_mcp") return "mcp" as const;
  if (route === "platform_webhook") return "webhook" as const;
  return "builtin" as const;
}

function recordStatus(status: ProviderDefinition["status"]) {
  return status === "configured" || status === "verified"
    ? ("active" as const)
    : ("disabled" as const);
}

export function makeProviderDefinitionRecord(args: {
  readonly definition: ProviderDefinition;
  readonly occurredAt?: Date | string;
  readonly version?: number;
}) {
  const occurredAt =
    typeof args.occurredAt === "string"
      ? args.occurredAt
      : (args.occurredAt ?? new Date()).toISOString();
  const definition = args.definition;

  return Schema.decodeUnknownSync(ProviderDefinitionRecord)(
    withCanonicalRecordKeys({
      data: {
        authMethods: [definition.auth.kind],
        codeVersion: providerDefinitionCodeVersion(definition),
        createdAt: occurredAt,
        displayName: definition.displayName,
        key: definition.key,
        metadata: {
          aliases: [...definition.aliases],
          apiHosts: [...definition.apiHosts],
          authorizationScopes: [...definition.authorizationScopes],
          category: definition.category,
          defaultScopes: [...definition.defaultScopes],
          oauthProviderKey: definition.oauthProviderKey ?? "",
          ...(definition.mcpServer
            ? {
                mcpRegistrationMethods:
                  definition.mcpServer.authorization.kind === "oauth"
                    ? [...definition.mcpServer.authorization.registrationMethods]
                    : [],
                mcpServerUrl: definition.mcpServer.url,
              }
            : {}),
          providerRoute: definition.route,
          supportsMultipleAccounts: definition.supportsMultipleAccounts,
        },
        route: recordRoute(definition.route),
        status: recordStatus(definition.status),
        supportedScopes: [
          ...new Set([...definition.authorizationScopes, ...definition.defaultScopes]),
        ].toSorted(),
        supportedTools: [...definition.tools],
        updatedAt: occurredAt,
        version: args.version ?? 1,
      },
      itemType: "provider-definition",
    }),
  );
}

export function makeProviderDefinitionRecords(
  definitions: readonly ProviderDefinition[],
  options: { readonly occurredAt?: Date | string; readonly version?: number } = {},
) {
  return definitions.map((definition) => makeProviderDefinitionRecord({ definition, ...options }));
}
