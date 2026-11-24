import type {
  ProviderAuthDefinitionInput,
  ProviderAuthFieldDefinitionInput,
  ProviderDefinitionInput,
  ProviderVerificationDefinitionInput,
} from "../provider-definitions.ts";

const PLANNED_STATUS = "planned" as const;

function field(input: ProviderAuthFieldDefinitionInput): ProviderAuthFieldDefinitionInput {
  return Object.freeze(input);
}

function auth(input: ProviderAuthDefinitionInput): ProviderAuthDefinitionInput {
  return Object.freeze({
    ...input,
    fields: Object.freeze([...(input.fields ?? [])]),
  });
}

const oauthAuth = auth({ kind: "oauth", fields: Object.freeze([]) });

export const noneAuth = auth({ kind: "none", fields: Object.freeze([]) });

function apiKeyAuth(key = "apiKey", displayName = "API key"): ProviderAuthDefinitionInput {
  return auth({
    kind: "api_key",
    fields: Object.freeze([
      field({
        key,
        displayName,
        sensitive: true,
        required: true,
        displayFormat: "masked",
      }),
    ]),
  });
}

export function bearerTokenAuth(
  key = "apiToken",
  displayName = "API token",
): ProviderAuthDefinitionInput {
  return auth({
    ...apiKeyAuth(key, displayName),
    transport: Object.freeze({ fieldKey: key, type: "bearer" }),
  });
}

export function bearerTokenWithPublicFieldAuth(
  publicKey: string,
  publicDisplayName: string,
  tokenKey: string,
  tokenDisplayName: string,
  publicDefaultValue?: string,
): ProviderAuthDefinitionInput {
  return auth({
    kind: "api_key",
    requestFieldKeys: Object.freeze([publicKey]),
    transport: Object.freeze({ fieldKey: tokenKey, type: "bearer" }),
    fields: Object.freeze([
      field({
        key: publicKey,
        displayName: publicDisplayName,
        sensitive: false,
        required: publicDefaultValue === undefined,
        displayFormat: "none",
        ...(publicDefaultValue === undefined ? {} : { defaultValue: publicDefaultValue }),
      }),
      field({
        key: tokenKey,
        displayName: tokenDisplayName,
        sensitive: true,
        required: true,
        displayFormat: "masked",
      }),
    ]),
  });
}

export function headerApiKeyAuth(
  headerName: string,
  key = "apiKey",
  displayName = "API key",
  prefix = "",
): ProviderAuthDefinitionInput {
  return auth({
    ...apiKeyAuth(key, displayName),
    transport: Object.freeze({
      fieldKey: key,
      headerName,
      prefix,
      type: "header",
    }),
  });
}

export function basicAuth(
  usernameKey = "username",
  usernameDisplayName = "Username",
  passwordKey = "password",
  passwordDisplayName = "Password",
): ProviderAuthDefinitionInput {
  return auth({
    kind: "basic",
    transport: Object.freeze({
      passwordFieldKey: passwordKey,
      type: "basic",
      usernameFieldKey: usernameKey,
    }),
    fields: Object.freeze([
      field({
        key: usernameKey,
        displayName: usernameDisplayName,
        sensitive: false,
        required: true,
        displayFormat: "none",
      }),
      field({
        key: passwordKey,
        displayName: passwordDisplayName,
        sensitive: true,
        required: true,
        displayFormat: "masked",
      }),
    ]),
  });
}

export function basicApiKeyAuth(
  key = "apiKey",
  displayName = "API key",
  placement: "password" | "username" = "password",
): ProviderAuthDefinitionInput {
  return auth({
    ...apiKeyAuth(key, displayName),
    transport: Object.freeze({
      ...(placement === "username" ? { usernameFieldKey: key } : { passwordFieldKey: key }),
      type: "basic",
    }),
  });
}

export function apiKeyWithPublicFieldAuth(
  publicKey: string,
  publicDisplayName: string,
  secretKey: string,
  secretDisplayName: string,
): ProviderAuthDefinitionInput {
  return auth({
    kind: "api_key",
    requestFieldKeys: Object.freeze([publicKey]),
    fields: Object.freeze([
      field({
        key: publicKey,
        displayName: publicDisplayName,
        sensitive: false,
        required: true,
        displayFormat: "none",
      }),
      field({
        key: secretKey,
        displayName: secretDisplayName,
        sensitive: true,
        required: true,
        displayFormat: "masked",
      }),
    ]),
  });
}

export function apiProbeVerification(description: string): ProviderVerificationDefinitionInput {
  return Object.freeze({ required: true, method: "api_probe", description });
}

export function oauthScopesVerification(description: string): ProviderVerificationDefinitionInput {
  return Object.freeze({ required: true, method: "oauth_scopes", description });
}

export function manualVerification(description: string): ProviderVerificationDefinitionInput {
  return Object.freeze({ required: false, method: "manual", description });
}

export function webhookChallengeVerification(
  description: string,
): ProviderVerificationDefinitionInput {
  return Object.freeze({
    required: true,
    method: "webhook_challenge",
    description,
  });
}

export function noVerification(description: string): ProviderVerificationDefinitionInput {
  return Object.freeze({ required: false, method: "none", description });
}

type CommonDefinitionArgs = {
  readonly aliases?: readonly string[];
  readonly apiHosts?: readonly string[];
  readonly authorizationScopes?: readonly string[];
  readonly authorizationScopeMode?: ProviderDefinitionInput["authorizationScopeMode"];
  readonly category: string;
  readonly defaultScopes?: readonly string[];
  readonly displayName: string;
  readonly key: string;
  readonly supportsMultipleAccounts: boolean;
  readonly status?: ProviderDefinitionInput["status"];
  readonly tools: readonly string[];
  readonly verification: ProviderVerificationDefinitionInput;
};

export function platformOAuthDefinition(
  args: CommonDefinitionArgs & { readonly oauthProviderKey: string },
): ProviderDefinitionInput {
  const { authorizationScopeMode, ...definition } = args;
  return Object.freeze({
    ...definition,
    route: "platform_oauth",
    auth: oauthAuth,
    status: args.status ?? PLANNED_STATUS,
    ...(authorizationScopeMode ? { authorizationScopeMode } : {}),
  });
}

export function platformApiCredentialDefinition(
  args: CommonDefinitionArgs & {
    readonly apiHosts: readonly string[];
    readonly auth: ProviderAuthDefinitionInput;
    readonly originPolicy?: ProviderDefinitionInput["originPolicy"];
  },
): ProviderDefinitionInput {
  const { authorizationScopeMode, originPolicy, ...definition } = args;
  return Object.freeze({
    ...definition,
    route: "platform_api_credential",
    status: args.status ?? PLANNED_STATUS,
    ...(authorizationScopeMode ? { authorizationScopeMode } : {}),
    ...(originPolicy ? { originPolicy } : {}),
  });
}

export function mcpGatewayDefinition(
  args: Omit<CommonDefinitionArgs, "apiHosts"> & {
    readonly auth?: ProviderAuthDefinitionInput;
  },
): ProviderDefinitionInput {
  const { auth: providerAuth, authorizationScopeMode, ...definition } = args;
  return Object.freeze({
    ...definition,
    route: "mcp_gateway",
    auth: providerAuth ?? noneAuth,
    apiHosts: Object.freeze([]),
    defaultScopes: args.defaultScopes ?? Object.freeze([]),
    status: args.status ?? PLANNED_STATUS,
    ...(authorizationScopeMode ? { authorizationScopeMode } : {}),
  });
}

export function webhookDefinition(
  args: Omit<CommonDefinitionArgs, "apiHosts" | "defaultScopes">,
): ProviderDefinitionInput {
  const { authorizationScopeMode, ...definition } = args;
  return Object.freeze({
    ...definition,
    route: "platform_webhook",
    auth: noneAuth,
    apiHosts: Object.freeze([]),
    defaultScopes: Object.freeze([]),
    status: args.status ?? PLANNED_STATUS,
    ...(authorizationScopeMode ? { authorizationScopeMode } : {}),
  });
}

export function sandboxDefinition(
  args: Omit<CommonDefinitionArgs, "apiHosts" | "defaultScopes">,
): ProviderDefinitionInput {
  const { authorizationScopeMode, ...definition } = args;
  return Object.freeze({
    ...definition,
    route: "sandbox_tool",
    auth: noneAuth,
    apiHosts: Object.freeze([]),
    defaultScopes: Object.freeze([]),
    status: args.status ?? PLANNED_STATUS,
    ...(authorizationScopeMode ? { authorizationScopeMode } : {}),
  });
}

export function platformOauthDefinition(
  args: CommonDefinitionArgs & {
    readonly apiHosts: readonly string[];
    readonly auth: ProviderAuthDefinitionInput;
    readonly oauthProviderKey: string;
    readonly originPolicy?: ProviderDefinitionInput["originPolicy"];
  },
): ProviderDefinitionInput {
  const { authorizationScopeMode, originPolicy, ...definition } = args;
  return Object.freeze({
    ...definition,
    route: "platform_oauth",
    status: args.status ?? PLANNED_STATUS,
    ...(authorizationScopeMode ? { authorizationScopeMode } : {}),
    ...(originPolicy ? { originPolicy } : {}),
  });
}
