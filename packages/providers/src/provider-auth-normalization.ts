import type {
  ProviderRoute,
  ProviderCredentialKind,
  ProviderAuthFieldValueType,
  ProviderAuthFieldDefinitionInput,
  ProviderAuthFieldDefinition,
  ProviderAuthDefinitionInput,
  ProviderAuthDefinition,
  ProviderTokenExchangeBodyFormat,
  ProviderTokenExchangeClientAuthentication,
  ProviderClientCredentialsTokenExchangeInput,
  ProviderClientCredentialsTokenExchange,
  ProviderAuthTransportType,
  ProviderAuthTransportInput,
  ProviderAuthTransport,
} from "./provider-definition-types.ts";
import {
  PROVIDER_CREDENTIAL_KINDS,
  PROVIDER_AUTH_FIELD_DISPLAY_FORMATS,
  PROVIDER_AUTH_FIELD_VALUE_TYPES,
  AUTH_FIELD_KEY_PATTERN,
  MAX_AUTH_FIELD_COUNT,
  PROVIDER_TOKEN_EXCHANGE_TYPES,
  PROVIDER_TOKEN_EXCHANGE_BODY_FORMATS,
  PROVIDER_TOKEN_EXCHANGE_CLIENT_AUTHENTICATIONS,
  PROVIDER_AUTH_TRANSPORT_TYPES,
} from "./provider-definition-types.ts";
import {
  freezeDeepArray,
  isPlainRecord,
  requireNonEmptyText,
  isNonTokenProviderRoute,
  isProviderCredentialKind,
  isAuthFieldDisplayFormat,
  normalizeOptionalDescription,
} from "./provider-key-schema-normalization.ts";

export function normalizeAuthField(
  input: ProviderAuthFieldDefinitionInput,
  seenKeys: Set<string>,
): ProviderAuthFieldDefinition {
  const key = requireNonEmptyText(input.key, "Auth field key", 64);
  if (!AUTH_FIELD_KEY_PATTERN.test(key)) {
    throw new Error(
      "Auth field key must start with a lowercase letter and contain only letters, digits, and underscores.",
    );
  }
  if (seenKeys.has(key)) {
    throw new Error(`Duplicate auth field key: ${key}.`);
  }
  seenKeys.add(key);

  const displayName = requireNonEmptyText(input.displayName, "Auth field display name", 120);
  const description = normalizeOptionalDescription(input.description, "Auth field description");
  const sensitive = input.sensitive === true;
  const required = input.required !== false;

  const rawDisplayFormat = input.displayFormat ?? (sensitive ? "masked" : "none");
  if (!isAuthFieldDisplayFormat(rawDisplayFormat)) {
    throw new Error(
      `Unsupported secret display value: ${rawDisplayFormat}. Allowed values are ${PROVIDER_AUTH_FIELD_DISPLAY_FORMATS.join(", ")}.`,
    );
  }
  if (!sensitive && (rawDisplayFormat === "last4" || rawDisplayFormat === "suffix")) {
    throw new Error(
      `Unsupported secret display value for non-sensitive field ${key}: ${rawDisplayFormat}.`,
    );
  }

  if (sensitive && input.defaultValue !== undefined) {
    throw new Error(`Secret defaults are not allowed for sensitive auth field ${key}.`);
  }

  const rawValueType = input.valueType ?? "string";
  if (!(PROVIDER_AUTH_FIELD_VALUE_TYPES as readonly string[]).includes(rawValueType)) {
    throw new Error(
      `Unsupported auth field valueType: ${rawValueType}. Allowed values are ${PROVIDER_AUTH_FIELD_VALUE_TYPES.join(", ")}.`,
    );
  }
  const valueType = rawValueType as ProviderAuthFieldValueType;

  let defaultValue: string | undefined;
  if (input.defaultValue !== undefined) {
    if (typeof input.defaultValue !== "string") {
      throw new Error(`Auth field ${key} defaultValue must be a string.`);
    }
    if (valueType === "json") {
      throw new Error(
        `Auth field ${key} with valueType json cannot declare a string defaultValue.`,
      );
    }
    defaultValue = input.defaultValue;
  }

  const field: ProviderAuthFieldDefinition = Object.freeze({
    key,
    displayName,
    sensitive,
    required,
    displayFormat: rawDisplayFormat,
    valueType,
    ...(description ? { description } : {}),
    ...(defaultValue !== undefined ? { defaultValue } : {}),
  });

  return field;
}

export function allowedCredentialKindsForRoute(
  route: ProviderRoute,
): readonly ProviderCredentialKind[] {
  switch (route) {
    case "platform_oauth":
      return ["oauth"];
    case "platform_api_credential":
      return ["api_key", "basic", "service_account", "json", "oauth_client_credentials"];
    case "mcp_gateway":
      return ["oauth", "api_key", "none"];
    case "vendor_mcp":
      return ["oauth", "api_key"];
    case "platform_webhook":
    case "sandbox_tool":
    case "manual_browser":
    case "unsupported":
      return ["none"];
  }
}

export function normalizeProviderAuthTransport(
  input: ProviderAuthTransportInput | undefined,
  fields: readonly ProviderAuthFieldDefinition[],
): ProviderAuthTransport | undefined {
  if (input === undefined) return undefined;
  if (!isPlainRecord(input)) throw new Error("Auth transport must be an object.");
  if (!(PROVIDER_AUTH_TRANSPORT_TYPES as readonly string[]).includes(input.type)) {
    throw new Error(
      `Unsupported auth transport type: ${input.type}. Allowed values are ${PROVIDER_AUTH_TRANSPORT_TYPES.join(", ")}.`,
    );
  }
  const type = input.type as ProviderAuthTransportType;
  const field = (value: string | undefined, label: string) => {
    const key = requireNonEmptyText(value ?? "", label, 64);
    if (!fields.some((entry) => entry.key === key)) {
      throw new Error(`${label} ${key} is not declared in auth fields.`);
    }
    return key;
  };
  if (input.prefix !== undefined && typeof input.prefix !== "string") {
    throw new Error("Auth transport prefix must be a string.");
  }
  const prefix = input.prefix ?? "";
  if (prefix.length > 128) throw new Error("Auth transport prefix is too long.");
  if (/[\r\n]/u.test(prefix)) throw new Error("Auth transport prefix contains invalid characters.");
  if (type === "basic") {
    const usernameFieldKey =
      input.usernameFieldKey === undefined
        ? undefined
        : field(input.usernameFieldKey, "Auth transport usernameFieldKey");
    const passwordFieldKey =
      input.passwordFieldKey === undefined
        ? undefined
        : field(input.passwordFieldKey, "Auth transport passwordFieldKey");
    if (!usernameFieldKey && !passwordFieldKey) {
      throw new Error("Basic auth transport requires usernameFieldKey, passwordFieldKey, or both.");
    }
    return Object.freeze({
      ...(passwordFieldKey ? { passwordFieldKey } : {}),
      prefix,
      type,
      ...(usernameFieldKey ? { usernameFieldKey } : {}),
    });
  }
  if (type === "headers") {
    if (!Array.isArray(input.headerFields) || input.headerFields.length === 0) {
      throw new Error("Headers auth transport requires at least one headerFields entry.");
    }
    if (input.headerFields.length > 8) {
      throw new Error("Headers auth transport may declare at most 8 header fields.");
    }
    const seenHeaders = new Set<string>();
    const headerFields = input.headerFields.map((entry, index) => {
      if (!isPlainRecord(entry)) {
        throw new Error(`Auth transport headerFields[${index}] must be an object.`);
      }
      const fieldKeyValue = entry.fieldKey;
      const headerNameValue = entry.headerName;
      const prefixValue = entry.prefix;
      if (fieldKeyValue !== undefined && typeof fieldKeyValue !== "string") {
        throw new Error(`Auth transport headerFields[${index}].fieldKey must be a string.`);
      }
      if (headerNameValue !== undefined && typeof headerNameValue !== "string") {
        throw new Error(`Auth transport headerFields[${index}].headerName must be a string.`);
      }
      if (prefixValue !== undefined && typeof prefixValue !== "string") {
        throw new Error(`Auth transport headerFields[${index}].prefix must be a string.`);
      }
      const fieldKey = field(fieldKeyValue, `Auth transport headerFields[${index}].fieldKey`);
      const headerName = requireNonEmptyText(
        headerNameValue ?? "",
        `Auth transport headerFields[${index}].headerName`,
        128,
      ).toLowerCase();
      if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(headerName)) {
        throw new Error(`Auth transport headerFields[${index}].headerName is invalid.`);
      }
      if (seenHeaders.has(headerName)) {
        throw new Error("Headers auth transport header names must be unique.");
      }
      seenHeaders.add(headerName);
      const headerPrefix = prefixValue ?? "";
      if (headerPrefix.length > 128 || /[\r\n]/u.test(headerPrefix)) {
        throw new Error(`Auth transport headerFields[${index}].prefix is invalid.`);
      }
      return Object.freeze({ fieldKey, headerName, prefix: headerPrefix });
    });
    return Object.freeze({ headerFields: Object.freeze(headerFields), prefix: "", type });
  }
  const fieldKey = field(input.fieldKey, "Auth transport fieldKey");
  if (type === "header") {
    const headerName = requireNonEmptyText(
      input.headerName ?? "",
      "Auth transport headerName",
      128,
    ).toLowerCase();
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(headerName)) {
      throw new Error("Auth transport headerName is invalid.");
    }
    return Object.freeze({ fieldKey, headerName, prefix, type });
  }
  if (type === "query") {
    const parameterName = requireNonEmptyText(
      input.parameterName ?? "",
      "Auth transport parameterName",
      128,
    );
    return Object.freeze({ fieldKey, parameterName, prefix, type });
  }
  return Object.freeze({ fieldKey, prefix: input.prefix ?? "Bearer ", type });
}

export function normalizeProviderClientCredentialsTokenExchange(
  input: ProviderClientCredentialsTokenExchangeInput | undefined,
  fields: readonly ProviderAuthFieldDefinition[],
): ProviderClientCredentialsTokenExchange | undefined {
  if (input === undefined) return undefined;
  if (!isPlainRecord(input)) throw new Error("Auth tokenExchange must be an object.");
  if (input.type !== "oauth_client_credentials") {
    throw new Error(
      `Unsupported auth tokenExchange type: ${input.type}. Allowed values are ${PROVIDER_TOKEN_EXCHANGE_TYPES.join(", ")}.`,
    );
  }
  const bodyFormat = input.bodyFormat ?? "form";
  if (!(PROVIDER_TOKEN_EXCHANGE_BODY_FORMATS as readonly string[]).includes(bodyFormat)) {
    throw new Error(
      `Unsupported auth tokenExchange bodyFormat: ${bodyFormat}. Allowed values are ${PROVIDER_TOKEN_EXCHANGE_BODY_FORMATS.join(", ")}.`,
    );
  }
  const clientAuthentication = input.clientAuthentication ?? "body";
  if (
    !(PROVIDER_TOKEN_EXCHANGE_CLIENT_AUTHENTICATIONS as readonly string[]).includes(
      clientAuthentication,
    )
  ) {
    throw new Error(
      `Unsupported auth tokenExchange clientAuthentication: ${clientAuthentication}. Allowed values are ${PROVIDER_TOKEN_EXCHANGE_CLIENT_AUTHENTICATIONS.join(", ")}.`,
    );
  }
  const credentialField = (value: string, label: string) => {
    const key = requireNonEmptyText(value, label, 64);
    const field = fields.find((entry) => entry.key === key);
    if (!field) throw new Error(`${label} ${key} is not declared in auth fields.`);
    if (field.valueType !== "string") {
      throw new Error(`${label} ${key} must reference a string auth field.`);
    }
    return field;
  };
  const clientIdField = credentialField(
    input.clientIdFieldKey,
    "Auth tokenExchange clientIdFieldKey",
  );
  const clientSecretField = credentialField(
    input.clientSecretFieldKey,
    "Auth tokenExchange clientSecretFieldKey",
  );
  if (!clientSecretField.sensitive) {
    throw new Error("Auth tokenExchange clientSecretFieldKey must reference a sensitive field.");
  }
  if (clientIdField.key === clientSecretField.key) {
    throw new Error("Auth tokenExchange client ID and secret fields must be distinct.");
  }
  const parameterName = (value: string | undefined, fallback: string, label: string) => {
    const normalized = requireNonEmptyText(value ?? fallback, label, 64);
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u.test(normalized)) {
      throw new Error(`${label} is invalid.`);
    }
    return normalized;
  };
  if (input.parameters !== undefined && !Array.isArray(input.parameters)) {
    throw new Error("Auth tokenExchange parameters must be an array.");
  }
  if ((input.parameters?.length ?? 0) > 16) {
    throw new Error("Auth tokenExchange may declare at most 16 additional parameters.");
  }
  const grantTypeParameterName = parameterName(
    input.grantTypeParameterName,
    "grant_type",
    "Auth tokenExchange grantTypeParameterName",
  );
  const clientIdParameterName = parameterName(
    input.clientIdParameterName,
    "client_id",
    "Auth tokenExchange clientIdParameterName",
  );
  const clientSecretParameterName = parameterName(
    input.clientSecretParameterName,
    "client_secret",
    "Auth tokenExchange clientSecretParameterName",
  );
  const reservedParameterNames = new Set([
    grantTypeParameterName,
    clientIdParameterName,
    clientSecretParameterName,
  ]);
  const parameters = (input.parameters ?? []).map((entry, index) => {
    if (!isPlainRecord(entry)) {
      throw new Error(`Auth tokenExchange parameters[${index}] must be an object.`);
    }
    const fieldKey = entry.fieldKey;
    const parameterNameValue = entry.parameterName;
    if (typeof fieldKey !== "string" || typeof parameterNameValue !== "string") {
      throw new Error(`Auth tokenExchange parameters[${index}] fields must be strings.`);
    }
    const field = credentialField(fieldKey, `Auth tokenExchange parameters[${index}].fieldKey`);
    if (field.sensitive) {
      throw new Error(
        `Auth tokenExchange parameters[${index}].fieldKey must reference a non-sensitive field.`,
      );
    }
    const name = parameterName(
      parameterNameValue,
      "",
      `Auth tokenExchange parameters[${index}].parameterName`,
    );
    if (reservedParameterNames.has(name)) {
      throw new Error(`Auth tokenExchange parameter ${name} is duplicated.`);
    }
    reservedParameterNames.add(name);
    return Object.freeze({ fieldKey: field.key, parameterName: name });
  });
  let endpoint: string;
  try {
    const url = new URL(requireNonEmptyText(input.endpoint, "Auth tokenExchange endpoint", 2048));
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      url.search ||
      url.hostname !== url.hostname.toLowerCase()
    ) {
      throw new Error("must be a credential-free HTTPS URL without query or fragment");
    }
    endpoint = url.toString();
  } catch (cause) {
    throw new Error("Auth tokenExchange endpoint must be a secure absolute URL.", { cause });
  }
  return Object.freeze({
    bodyFormat: bodyFormat as ProviderTokenExchangeBodyFormat,
    clientAuthentication: clientAuthentication as ProviderTokenExchangeClientAuthentication,
    clientIdFieldKey: clientIdField.key,
    clientIdParameterName,
    clientSecretFieldKey: clientSecretField.key,
    clientSecretParameterName,
    endpoint,
    grantTypeParameterName,
    parameters: Object.freeze(parameters),
    type: "oauth_client_credentials",
  });
}

export function providerAuthTransportFieldKeys(
  transport: ProviderAuthTransport,
): readonly string[] {
  if (transport.type === "basic") {
    return [transport.usernameFieldKey, transport.passwordFieldKey].filter(
      (value): value is string => Boolean(value),
    );
  }
  if (transport.type === "headers") {
    return transport.headerFields?.map((entry) => entry.fieldKey) ?? [];
  }
  return transport.fieldKey ? [transport.fieldKey] : [];
}

export function normalizeProviderAuthDefinition(
  input: ProviderAuthDefinitionInput,
  route: ProviderRoute,
): ProviderAuthDefinition {
  const kindRaw = requireNonEmptyText(input.kind, "Credential kind", 64);
  if (!isProviderCredentialKind(kindRaw)) {
    throw new Error(
      `Unsupported credential kind: ${kindRaw}. Allowed values are ${PROVIDER_CREDENTIAL_KINDS.join(", ")}.`,
    );
  }
  const kind = kindRaw;
  const allowed = allowedCredentialKindsForRoute(route);
  if (!allowed.includes(kind)) {
    throw new Error(
      `Invalid route/auth combination: route ${route} does not allow credential kind ${kind}.`,
    );
  }

  const fieldsInput = input.fields ?? [];
  if (fieldsInput.length > MAX_AUTH_FIELD_COUNT) {
    throw new Error(`Provider may declare at most ${MAX_AUTH_FIELD_COUNT} auth fields.`);
  }

  const seenKeys = new Set<string>();
  const fields = fieldsInput.map((field) => normalizeAuthField(field, seenKeys));
  const transport = normalizeProviderAuthTransport(input.transport, fields);
  const tokenExchange = normalizeProviderClientCredentialsTokenExchange(
    input.tokenExchange,
    fields,
  );
  const requestFieldKeys = [...new Set(input.requestFieldKeys ?? [])].map((key) => {
    const normalized = requireNonEmptyText(key, "Auth request field key", 64);
    const field = fields.find((entry) => entry.key === normalized);
    if (!field) throw new Error(`Auth request field key ${normalized} is not declared.`);
    if (field.sensitive)
      throw new Error(`Auth request field key ${normalized} must not be sensitive.`);
    return normalized;
  });

  if (isNonTokenProviderRoute(route)) {
    const sensitive = fields.filter((field) => field.sensitive);
    if (sensitive.length > 0) {
      throw new Error(
        `Token-bearing fields are not allowed on non-token route ${route}: ${sensitive
          .map((field) => field.key)
          .join(", ")}.`,
      );
    }
    if (kind !== "none") {
      throw new Error(
        `Invalid route/auth combination: non-token route ${route} requires credential kind none.`,
      );
    }
  }

  if (kind === "none" && fields.some((field) => field.sensitive)) {
    throw new Error("Credential kind none cannot declare sensitive auth fields.");
  }

  if (kind === "oauth_client_credentials" && !tokenExchange) {
    throw new Error("Credential kind oauth_client_credentials requires auth tokenExchange.");
  }
  if (kind !== "oauth_client_credentials" && tokenExchange) {
    throw new Error("Auth tokenExchange requires credential kind oauth_client_credentials.");
  }
  if (tokenExchange && transport) {
    if (transport.type !== "header" && transport.type !== "headers") {
      throw new Error(
        "OAuth client-credentials supplemental transport must use header or headers transport.",
      );
    }
    const supplementalHeaderNames =
      transport.type === "headers"
        ? (transport.headerFields?.map((entry) => entry.headerName) ?? [])
        : [transport.headerName!];
    if (supplementalHeaderNames.includes("authorization")) {
      throw new Error(
        "OAuth client-credentials supplemental transport cannot replace Authorization.",
      );
    }
    for (const fieldKey of providerAuthTransportFieldKeys(transport)) {
      const field = fields.find((entry) => entry.key === fieldKey)!;
      if (field.sensitive) {
        throw new Error(
          "OAuth client-credentials supplemental transport must use non-sensitive fields.",
        );
      }
    }
  }

  return Object.freeze({
    kind,
    fields: freezeDeepArray(fields),
    requestFieldKeys: freezeDeepArray(requestFieldKeys),
    ...(tokenExchange ? { tokenExchange } : {}),
    ...(transport ? { transport } : {}),
  });
}
