const PROVIDER_REQUEST_HEADERS_FIELD = "deploymentsAi.providerRequestHeaders";
const OAUTH_RESOURCE_FIELD = "deploymentsAi.oauthResource";
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/u;

function normalizedHeaders(headers: Readonly<Record<string, unknown>>) {
  const entries = Object.entries(headers).map(([rawName, rawValue]) => {
    const name = rawName.trim().toLowerCase();
    if (typeof rawValue !== "string") {
      throw new Error("Provider request headers contain an invalid name or value.");
    }
    const value = rawValue.trim();
    if (!HEADER_NAME.test(name) || !value) {
      throw new Error("Provider request headers contain an invalid name or value.");
    }
    return [name, value] as const;
  });
  return Object.freeze(Object.fromEntries(entries));
}

function normalizedResource(value: string) {
  const resource = new URL(value);
  if (
    resource.protocol !== "https:" ||
    resource.username ||
    resource.password ||
    resource.search ||
    resource.hash ||
    (resource.pathname !== "/" && resource.pathname !== "")
  ) {
    throw new Error("OAuth resource must be an HTTPS origin.");
  }
  return resource.origin;
}

export function assertNoReservedProviderOAuthMaterialFields(
  values: Readonly<Record<string, string>>,
) {
  if (
    Object.hasOwn(values, PROVIDER_REQUEST_HEADERS_FIELD) ||
    Object.hasOwn(values, OAUTH_RESOURCE_FIELD)
  ) {
    throw new Error("Credential values contain a reserved provider OAuth material field.");
  }
}

export function credentialValuesWithProviderOAuthMaterial(
  values: Readonly<Record<string, string>>,
  material: {
    readonly requestHeaders?: Readonly<Record<string, string>>;
    readonly resource?: string;
  },
): Readonly<Record<string, string>> {
  const requestHeaders = normalizedHeaders(material.requestHeaders ?? {});
  return {
    ...values,
    ...(Object.keys(requestHeaders).length > 0
      ? { [PROVIDER_REQUEST_HEADERS_FIELD]: JSON.stringify(requestHeaders) }
      : {}),
    ...(material.resource ? { [OAUTH_RESOURCE_FIELD]: normalizedResource(material.resource) } : {}),
  };
}

export function providerOAuthMaterialFromCredentialValues(
  values: Readonly<Record<string, string>>,
): {
  readonly fields: Readonly<Record<string, string>>;
  readonly requestHeaders?: Readonly<Record<string, string>>;
  readonly resource?: string;
} {
  const fields = { ...values };
  const encodedHeaders = fields[PROVIDER_REQUEST_HEADERS_FIELD];
  const encodedResource = fields[OAUTH_RESOURCE_FIELD];
  delete fields[PROVIDER_REQUEST_HEADERS_FIELD];
  delete fields[OAUTH_RESOURCE_FIELD];

  let requestHeaders: Readonly<Record<string, string>> | undefined;
  if (encodedHeaders) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(encodedHeaders);
    } catch (cause) {
      throw new Error("Provider request headers credential field is invalid JSON.", { cause });
    }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new Error("Provider request headers credential field must be an object.");
    }
    requestHeaders = normalizedHeaders(decoded as Readonly<Record<string, unknown>>);
  }

  return {
    fields,
    ...(requestHeaders && Object.keys(requestHeaders).length > 0 ? { requestHeaders } : {}),
    ...(encodedResource ? { resource: normalizedResource(encodedResource) } : {}),
  };
}
