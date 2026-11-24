import type { ToolAdapterDefinition } from "../types.ts";

import {
  PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY,
  type ProviderNativeHttpToolDefinition,
  type ProviderNativeInputSchema,
} from "./core-types.ts";

const LEGACY_PROVIDER_INPUT_SCHEMA = Object.freeze({
  additionalProperties: true,
  properties: {},
  type: "object" as const,
});

const ARTIFACT_HANDOFF_INPUT_PROPERTY = Object.freeze({
  additionalProperties: false,
  properties: {
    artifactId: { minLength: 1, type: "string" as const },
    contentType: { minLength: 1, type: "string" as const },
    fileName: { minLength: 1, type: "string" as const },
    intentId: { minLength: 1, type: "string" as const },
  },
  required: ["artifactId", "contentType", "fileName", "intentId"],
  type: "object" as const,
});

function adapterInputSchema(
  definition: ProviderNativeHttpToolDefinition,
): ProviderNativeInputSchema {
  const schema = definition.inputSchema ?? LEGACY_PROVIDER_INPUT_SCHEMA;
  if (definition.effect !== "write" || definition.defaultPolicyAction !== "require_approval") {
    return schema;
  }
  return {
    ...schema,
    properties: {
      ...schema.properties,
      [PROVIDER_NATIVE_ARTIFACT_HANDOFF_INPUT_KEY]: ARTIFACT_HANDOFF_INPUT_PROPERTY,
    },
  };
}

export function sqlCodeWithoutCommentsAndLiterals(statement: string): string {
  let result = "";
  let index = 0;
  let state: "code" | "double" | "line-comment" | "single" | "block-comment" | "dollar" = "code";
  let dollarDelimiter = "";

  while (index < statement.length) {
    const current = statement[index] ?? "";
    const next = statement[index + 1] ?? "";

    if (state === "code") {
      if (current === "-" && next === "-") {
        state = "line-comment";
        result += "  ";
        index += 2;
        continue;
      }
      if (current === "/" && next === "*") {
        state = "block-comment";
        result += "  ";
        index += 2;
        continue;
      }
      if (current === "'") {
        state = "single";
        result += " ";
        index += 1;
        continue;
      }
      if (current === '"') {
        state = "double";
        result += " ";
        index += 1;
        continue;
      }
      if (current === "$") {
        const delimiter = statement.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u)?.[0];
        if (delimiter) {
          state = "dollar";
          dollarDelimiter = delimiter;
          result += " ".repeat(delimiter.length);
          index += delimiter.length;
          continue;
        }
      }
      result += current;
      index += 1;
      continue;
    }

    if (state === "line-comment") {
      if (current === "\n" || current === "\r") {
        state = "code";
        result += current;
      } else {
        result += " ";
      }
      index += 1;
      continue;
    }

    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        state = "code";
        result += "  ";
        index += 2;
      } else {
        result += current === "\n" || current === "\r" ? current : " ";
        index += 1;
      }
      continue;
    }

    if (state === "single") {
      if (current === "'" && next === "'") {
        result += "  ";
        index += 2;
      } else if (current === "'") {
        state = "code";
        result += " ";
        index += 1;
      } else {
        result += current === "\n" || current === "\r" ? current : " ";
        index += 1;
      }
      continue;
    }

    if (state === "double") {
      if (current === '"' && next === '"') {
        result += "  ";
        index += 2;
      } else if (current === '"') {
        state = "code";
        result += " ";
        index += 1;
      } else {
        result += current === "\n" || current === "\r" ? current : " ";
        index += 1;
      }
      continue;
    }

    if (state === "dollar") {
      if (statement.startsWith(dollarDelimiter, index)) {
        state = "code";
        result += " ".repeat(dollarDelimiter.length);
        index += dollarDelimiter.length;
      } else {
        result += current === "\n" || current === "\r" ? current : " ";
        index += 1;
      }
    }
  }

  return result;
}

export function providerNativeAcceptedProviders(
  definition: ProviderNativeHttpToolDefinition,
): string[] {
  return [...(definition.acceptedProviders ?? [definition.provider])];
}

export function providerNativeToolDefinitionToAdapter(
  definition: ProviderNativeHttpToolDefinition,
): ToolAdapterDefinition {
  return {
    ...(definition.authorizationScopes !== undefined
      ? { authorizationScopes: [...definition.authorizationScopes] }
      : {}),
    ...(definition.auditMetadata !== undefined ? { auditMetadata: definition.auditMetadata } : {}),
    defaultPolicyAction: definition.defaultPolicyAction,
    description: definition.description,
    effect: definition.effect,
    egress: definition.egress ?? "configured",
    execution: { type: "builtin", adapterKey: definition.toolName },
    inputSchema: adapterInputSchema(definition),
    ...(definition.hostPolicy !== undefined ? { hostPolicy: definition.hostPolicy } : {}),
    provider: definition.provider,
    ...(definition.effect !== "read" || definition.effectMetadata?.outboundMutation === true
      ? { providerOutboundMutation: true as const }
      : {}),
    ...(definition.rateLimitPolicy !== undefined
      ? { rateLimitPolicy: definition.rateLimitPolicy }
      : {}),
    requiredScopes: [...(definition.requiredScopes ?? [])],
    ...(definition.resourceMetadata !== undefined
      ? { resourceMetadata: definition.resourceMetadata }
      : {}),
    ...(definition.retryPolicy !== undefined ? { retryPolicy: definition.retryPolicy } : {}),
    status: "active",
    toolName: definition.toolName,
  };
}
