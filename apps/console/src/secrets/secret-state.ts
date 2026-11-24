import {
  CREDENTIAL_REFERENCE_OWNER_TYPES,
  type CredentialReferenceResponse,
} from "@deployments-ai/api-contract/credential-references";
import { oneOf } from "../observability/range.ts";
import type { ResourceRef } from "../resource-links.ts";

export type CredentialReference = typeof CredentialReferenceResponse.Type;
export type OwnerType = CredentialReference["ownerType"];

export const OWNER_LABELS: Readonly<Record<OwnerType, string>> = {
  "channel-binding": "Channel binding",
  "mcp-server": "MCP server",
  "provider-application": "OAuth app",
  "provider-connection": "Connection",
  "tool-adapter": "Extension",
  "webhook-endpoint": "Webhook endpoint",
};

export const PURPOSE_LABELS: Readonly<Record<string, string>> = {
  "channel-runtime": "Channel runtime credential",
  "extension-callback-auth": "Callback authentication",
  "hosted-code-secrets": "Hosted code secrets",
  "mcp-server-auth": "MCP server authentication",
  "provider-api": "Provider API credential",
  "provider-oauth-client-secret": "OAuth client secret",
  "provider-oauth-token": "OAuth token",
  "webhook-signing": "Webhook signing secret",
};

export function ownerRef({
  ownerId,
  ownerType,
}: Pick<CredentialReference, "ownerId" | "ownerType">): ResourceRef | undefined {
  switch (ownerType) {
    case "channel-binding":
      return undefined;
    case "mcp-server":
      return { kind: "mcpServer", mcpServerId: ownerId };
    case "provider-application":
      return { kind: "oauthApps" };
    case "provider-connection":
      return { connectionId: ownerId, kind: "connection" };
    case "tool-adapter":
      return { extensionId: ownerId, kind: "extension" };
    case "webhook-endpoint":
      return { kind: "webhook", webhookId: ownerId };
  }
}

export interface SecretSearch {
  readonly owner?: OwnerType;
}

export function parseSecretSearch(search: Readonly<Record<string, unknown>>): SecretSearch {
  const owner = oneOf(CREDENTIAL_REFERENCE_OWNER_TYPES, search.owner);
  return owner === undefined ? {} : { owner };
}
