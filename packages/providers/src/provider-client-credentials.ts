import type { ProviderClientCredentialsTokenExchange } from "./provider-definitions.ts";

export type ProviderClientCredentialsTokenRequest = Readonly<{
  body: string;
  endpoint: string;
  headers: Readonly<Record<string, string>>;
  method: "POST";
}>;

export type ProviderClientCredentialsAccessToken = Readonly<{
  accessToken: string;
  expiresInSeconds: number;
  tokenType: "Bearer";
}>;

function requiredCredentialField(
  fields: Readonly<Record<string, unknown>>,
  fieldKey: string,
): string {
  const value = fields[fieldKey];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Provider credential is missing required token-exchange field ${fieldKey}.`);
  }
  return value.trim();
}

export function buildProviderClientCredentialsTokenRequest(args: {
  readonly exchange: ProviderClientCredentialsTokenExchange;
  readonly fields: Readonly<Record<string, unknown>>;
}): ProviderClientCredentialsTokenRequest {
  const clientId = requiredCredentialField(args.fields, args.exchange.clientIdFieldKey);
  const clientSecret = requiredCredentialField(args.fields, args.exchange.clientSecretFieldKey);
  const values: Record<string, string> = {
    [args.exchange.grantTypeParameterName]: "client_credentials",
    ...(args.exchange.clientAuthentication === "body"
      ? {
          [args.exchange.clientIdParameterName]: clientId,
          [args.exchange.clientSecretParameterName]: clientSecret,
        }
      : {}),
  };
  for (const parameter of args.exchange.parameters) {
    values[parameter.parameterName] = requiredCredentialField(args.fields, parameter.fieldKey);
  }
  const body =
    args.exchange.bodyFormat === "json"
      ? JSON.stringify(values)
      : new URLSearchParams(values).toString();
  return Object.freeze({
    body,
    endpoint: args.exchange.endpoint,
    headers: Object.freeze({
      accept: "application/json",
      ...(args.exchange.clientAuthentication === "basic"
        ? {
            authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`,
          }
        : {}),
      "content-type":
        args.exchange.bodyFormat === "json"
          ? "application/json"
          : "application/x-www-form-urlencoded",
    }),
    method: "POST",
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Provider token exchange response must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

export function parseProviderClientCredentialsTokenResponse(
  value: unknown,
): ProviderClientCredentialsAccessToken {
  const response = record(value);
  const accessToken = response.access_token;
  if (typeof accessToken !== "string" || !accessToken.trim()) {
    throw new Error("Provider token exchange response did not include access_token.");
  }
  const tokenType = response.token_type;
  if (
    tokenType !== undefined &&
    (typeof tokenType !== "string" || tokenType.trim().toLowerCase() !== "bearer")
  ) {
    throw new Error("Provider token exchange response returned an unsupported token_type.");
  }
  const expiresIn = response.expires_in;
  const expiresInSeconds =
    typeof expiresIn === "string" && /^\d+$/u.test(expiresIn.trim())
      ? Number(expiresIn)
      : expiresIn;
  if (
    typeof expiresInSeconds !== "number" ||
    !Number.isSafeInteger(expiresInSeconds) ||
    expiresInSeconds <= 0 ||
    expiresInSeconds > 31 * 24 * 60 * 60
  ) {
    throw new Error("Provider token exchange response returned an invalid expires_in.");
  }
  return Object.freeze({
    accessToken: accessToken.trim(),
    expiresInSeconds,
    tokenType: "Bearer",
  });
}
