import { SUPPORTED_OAUTH_SCOPES } from "@deployments-ai/identity";

/** A confidential OAuth client the install operator declares in `platform_identity_additional_clients`. */
export interface DeclaredOAuthClient {
  readonly allowedScopes: readonly string[];
  readonly clientId: string;
  readonly name: string;
  readonly redirectUris: readonly string[];
  readonly secretArn: string;
}

const supportedScopes: ReadonlySet<string> = new Set(SUPPORTED_OAUTH_SCOPES);
const outputName = "platform_identity_bootstrap.additional_clients";

function textList(value: unknown, path: string) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry)) {
    throw new Error(`OpenTofu output ${path} must be an array of non-empty strings.`);
  }
  return value as readonly string[];
}

function text(value: unknown, path: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`OpenTofu output ${path} is required.`);
  }
  return value.trim();
}

/**
 * Decodes the declared clients and refuses a scope identity does not support. OpenTofu checks
 * the IDs and redirect URIs; only this side knows the scope list.
 */
export function declaredOAuthClients(value: unknown): readonly DeclaredOAuthClient[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`OpenTofu output ${outputName} must be an object.`);
  }
  return Object.entries(value).map(([clientId, client]: [string, unknown]) => {
    const path = `${outputName}.${clientId}`;
    if (typeof client !== "object" || client === null || Array.isArray(client)) {
      throw new Error(`OpenTofu output ${path} must be an object.`);
    }
    const field = (name: string): unknown => Reflect.get(client, name);
    const allowedScopes = textList(field("allowed_scopes"), `${path}.allowed_scopes`);
    const unsupported = allowedScopes.filter((scope) => !supportedScopes.has(scope));
    if (unsupported.length > 0) {
      throw new Error(
        `platform_identity_additional_clients.${clientId}.allowed_scopes has scopes identity does not support: ${unsupported.join(", ")}.`,
      );
    }
    return {
      allowedScopes,
      clientId,
      name: text(field("name"), `${path}.name`),
      redirectUris: textList(field("redirect_uris"), `${path}.redirect_uris`),
      secretArn: text(field("secret_arn"), `${path}.secret_arn`),
    };
  });
}
