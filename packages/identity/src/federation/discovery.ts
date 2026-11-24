import { FederationError } from "./errors.ts";
import { requestJsonObject, type FederationHttp, type JsonObject } from "./http.ts";

export type FederationSigningAlgorithm = "RS256" | "PS256" | "ES256";

const SUPPORTED_SIGNING_ALGORITHMS: readonly FederationSigningAlgorithm[] = [
  "RS256",
  "PS256",
  "ES256",
];

export interface FederationEndpoints {
  readonly authorization: string;
  readonly token: string;
  readonly jwks: string;
  readonly userinfo?: string;
}

export interface DiscoveredProvider {
  readonly issuer: string;
  readonly endpoints: FederationEndpoints;
  readonly signingAlgorithms: readonly [
    FederationSigningAlgorithm,
    ...FederationSigningAlgorithm[],
  ];
  readonly tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post";
}

export interface FederationConnection extends DiscoveredProvider {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly redirectUri: string;
}

function discoveryUrl(issuer: string): string {
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new FederationError("issuer_invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    issuer.includes("?") ||
    issuer.includes("#")
  ) {
    throw new FederationError("issuer_invalid");
  }
  return `${issuer.replace(/\/$/u, "")}/.well-known/openid-configuration`;
}

function httpsEndpoint(document: JsonObject, name: string): string {
  const value = document[name];
  if (typeof value !== "string" || !URL.canParse(value)) {
    throw new FederationError("discovery_failed");
  }
  if (new URL(value).protocol !== "https:")
    throw new FederationError("discovery_insecure_endpoint");
  return value;
}

function optionalStringList(document: JsonObject, name: string): readonly string[] | undefined {
  const value: unknown = document[name];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new FederationError("discovery_failed");
  }
  return value;
}

function signingAlgorithms(document: JsonObject): DiscoveredProvider["signingAlgorithms"] {
  const advertised = optionalStringList(document, "id_token_signing_alg_values_supported") ?? [
    "RS256",
  ];
  const [first, ...rest] = SUPPORTED_SIGNING_ALGORITHMS.filter((algorithm) =>
    advertised.includes(algorithm),
  );
  if (first === undefined) throw new FederationError("discovery_signing_algorithm_unsupported");
  return [first, ...rest];
}

function tokenEndpointAuthMethod(
  document: JsonObject,
): DiscoveredProvider["tokenEndpointAuthMethod"] {
  const advertised = optionalStringList(document, "token_endpoint_auth_methods_supported");
  if (advertised === undefined || advertised.includes("client_secret_basic")) {
    return "client_secret_basic";
  }
  if (advertised.includes("client_secret_post")) return "client_secret_post";
  throw new FederationError("discovery_client_auth_unsupported");
}

export async function discoverProvider(input: {
  readonly issuer: string;
  readonly http: FederationHttp;
}): Promise<DiscoveredProvider> {
  const document = await requestJsonObject({
    failure: "discovery_failed",
    http: input.http,
    request: {
      headers: { accept: "application/json" },
      method: "GET",
      url: discoveryUrl(input.issuer),
    },
  });
  if (document.issuer !== input.issuer) throw new FederationError("discovery_issuer_mismatch");
  const userinfo =
    document.userinfo_endpoint === undefined
      ? undefined
      : httpsEndpoint(document, "userinfo_endpoint");
  const endpoints = {
    authorization: httpsEndpoint(document, "authorization_endpoint"),
    jwks: httpsEndpoint(document, "jwks_uri"),
    token: httpsEndpoint(document, "token_endpoint"),
    ...(userinfo === undefined ? {} : { userinfo }),
  };
  if (!optionalStringList(document, "response_types_supported")?.includes("code")) {
    throw new FederationError("discovery_code_flow_unsupported");
  }
  return {
    endpoints,
    issuer: input.issuer,
    signingAlgorithms: signingAlgorithms(document),
    tokenEndpointAuthMethod: tokenEndpointAuthMethod(document),
  };
}
