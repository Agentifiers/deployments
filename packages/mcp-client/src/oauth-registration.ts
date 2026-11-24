import {
  oauthHttpContext,
  parseHttpsUrl,
  parseJsonObject,
  pinnedOAuthRequest,
  type OAuthHttpInput,
  type OAuthHttpOutcome,
} from "./oauth-pinned-http.ts";

/** RFC 6749 §5.2 `error` value charset, bounded so hostile servers cannot inject text. */
const OAUTH_ERROR_CODE = /^[\x20\x21\x23-\x5B\x5D-\x7E]{1,64}$/;
const SECRET_AUTH_METHODS: Readonly<Record<string, true>> = {
  client_secret_basic: true,
  client_secret_jwt: true,
  client_secret_post: true,
};

export interface DynamicOAuthClientMetadata {
  readonly application_type: "native" | "web";
  readonly client_name: string;
  readonly client_uri?: string;
  readonly grant_types: readonly string[];
  readonly redirect_uris: readonly string[];
  readonly response_types: readonly string[];
  readonly token_endpoint_auth_method: string;
}

export interface RegisterDynamicOAuthClientInput extends OAuthHttpInput {
  readonly metadata: DynamicOAuthClientMetadata;
  readonly registrationEndpoint: string;
}

export interface DynamicOAuthClientRegistration {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly clientSecretExpiresAt?: number;
  readonly registrationClientUri?: string;
  readonly tokenEndpointAuthMethod: string;
}

/** Messages never include response bodies, descriptions, or credentials. */
export class McpClientRegistrationError extends Error {
  readonly oauthError?: string;
  readonly status?: number;

  constructor(
    message: string,
    details: { readonly oauthError?: string; readonly status?: number } = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "McpClientRegistrationError";
    if (details.oauthError !== undefined) this.oauthError = details.oauthError;
    if (details.status !== undefined) this.status = details.status;
  }
}

function optionalString(
  document: Readonly<Record<string, unknown>>,
  field: string,
  status: number,
): string | undefined {
  const value = document[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value) {
    throw new McpClientRegistrationError(
      `Dynamic client registration response field ${field} is invalid.`,
      { status },
    );
  }
  return value;
}

function parseRegistration(
  body: string,
  status: number,
  metadata: DynamicOAuthClientMetadata,
): DynamicOAuthClientRegistration {
  const document = parseJsonObject(body);
  if (!document) {
    throw new McpClientRegistrationError(
      "Dynamic client registration response was not a JSON object.",
      { status },
    );
  }
  const clientId = optionalString(document, "client_id", status);
  if (!clientId) {
    throw new McpClientRegistrationError(
      "Dynamic client registration response did not include client_id.",
      { status },
    );
  }
  const clientSecret = optionalString(document, "client_secret", status);
  const tokenEndpointAuthMethod =
    optionalString(document, "token_endpoint_auth_method", status) ??
    metadata.token_endpoint_auth_method;
  const registrationClientUri = optionalString(document, "registration_client_uri", status);
  const expiresAt = document.client_secret_expires_at;
  if (
    expiresAt !== undefined &&
    (typeof expiresAt !== "number" || !Number.isSafeInteger(expiresAt) || expiresAt < 0)
  ) {
    throw new McpClientRegistrationError(
      "Dynamic client registration response field client_secret_expires_at is invalid.",
      { status },
    );
  }
  const redirectUris = document.redirect_uris;
  if (
    redirectUris !== undefined &&
    (!Array.isArray(redirectUris) ||
      !metadata.redirect_uris.every((uri) => redirectUris.includes(uri)))
  ) {
    throw new McpClientRegistrationError(
      "Dynamic client registration response did not register the requested redirect URIs.",
      { status },
    );
  }
  if (Object.hasOwn(SECRET_AUTH_METHODS, tokenEndpointAuthMethod) && !clientSecret) {
    throw new McpClientRegistrationError(
      `Dynamic client registration returned ${tokenEndpointAuthMethod} without a client secret.`,
      { status },
    );
  }
  return {
    clientId,
    ...(clientSecret ? { clientSecret } : {}),
    ...(expiresAt === undefined ? {} : { clientSecretExpiresAt: expiresAt }),
    ...(registrationClientUri ? { registrationClientUri } : {}),
    tokenEndpointAuthMethod,
  };
}

/**
 * RFC 7591 dynamic client registration over DNS-pinned HTTPS (no redirects, 64 KiB cap,
 * 10 s default deadline). Accepts 201 or 200 responses.
 */
export async function registerDynamicOAuthClient(
  input: RegisterDynamicOAuthClientInput,
): Promise<DynamicOAuthClientRegistration> {
  const url = parseHttpsUrl(input.registrationEndpoint);
  if (!url) {
    throw new McpClientRegistrationError("Registration endpoint must be an absolute HTTPS URL.");
  }
  const context = oauthHttpContext(input);
  let outcome: OAuthHttpOutcome;
  try {
    outcome = await pinnedOAuthRequest(context, {
      body: JSON.stringify(input.metadata),
      headers: { accept: "application/json", "content-type": "application/json" },
      method: "POST",
      readBody: true,
      url,
    });
  } catch (cause) {
    throw new McpClientRegistrationError(
      context.signal.aborted
        ? "Dynamic client registration timed out or was aborted."
        : "Dynamic client registration request failed.",
      {},
      { cause },
    );
  } finally {
    context.close();
  }
  if (outcome.kind === "redirect") {
    throw new McpClientRegistrationError("Dynamic client registration endpoint redirected.");
  }
  if (outcome.kind === "too-large") {
    throw new McpClientRegistrationError("Dynamic client registration response was too large.", {
      status: outcome.status,
    });
  }
  if (outcome.status !== 200 && outcome.status !== 201) {
    const error = parseJsonObject(outcome.body)?.error;
    const oauthError =
      typeof error === "string" && OAUTH_ERROR_CODE.test(error) ? error : undefined;
    throw new McpClientRegistrationError(
      `Dynamic client registration failed with HTTP ${outcome.status}${oauthError ? ` (${oauthError})` : ""}.`,
      { ...(oauthError ? { oauthError } : {}), status: outcome.status },
    );
  }
  return parseRegistration(outcome.body, outcome.status, input.metadata);
}
