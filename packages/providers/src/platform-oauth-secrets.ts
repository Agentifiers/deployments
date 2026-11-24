import type { Ulid } from "@deployments-ai/db/ids";
import type { PlatformOAuthSecretDocument } from "./platform-oauth-types.ts";
import { PLATFORM_OAUTH_SECRET_SCHEMA_VERSION } from "./platform-oauth-types.ts";
import { isRecord, requiredText, optionalText, oauthKey } from "./platform-oauth-config.ts";
import { parsePlatformOAuthTokenResponse } from "./platform-oauth-flow.ts";

export function secretNameComponent(value: string): string {
  return requiredText(value, "OAuth secret name component", 256).replace(
    /[^a-zA-Z0-9_+=.@-]/gu,
    "-",
  );
}

export function parsePlatformOAuthSecretDocument(
  raw: string,
  expected: {
    readonly connectorAccountId: string;
    readonly organizationId: string;
    readonly providerKey: string;
  },
): PlatformOAuthSecretDocument {
  let value: unknown;
  try {
    value = JSON.parse(requiredText(raw, "OAuth connection secret", 65_536));
  } catch (cause) {
    if (cause instanceof SyntaxError)
      throw new Error("OAuth connection secret is invalid JSON.", { cause });
    throw cause;
  }
  if (!isRecord(value)) throw new Error("OAuth connection secret must be an object.");
  const schemaVersion = value.schemaVersion;
  const organizationId = requiredText(value.organizationId, "OAuth secret organizationId", 256);
  const connectorAccountId = requiredText(
    value.connectorAccountId,
    "OAuth secret connectorAccountId",
    256,
  );
  const providerKey = requiredText(value.providerKey, "OAuth secret providerKey", 64);
  if (
    schemaVersion !== PLATFORM_OAUTH_SECRET_SCHEMA_VERSION ||
    organizationId !== expected.organizationId ||
    connectorAccountId !== expected.connectorAccountId ||
    providerKey !== expected.providerKey
  ) {
    throw new Error("OAuth connection secret identity does not match the connector account.");
  }
  const token = parsePlatformOAuthTokenResponse(
    {
      access_token: value.accessToken,
      authorized_account_ids: value.authorizedAccountIds,
      refresh_token: value.refreshToken,
      scope: value.scopes,
      token_type: value.tokenType,
    },
    0,
  );
  const expiresAt = value.expiresAt;
  if (expiresAt !== undefined && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))) {
    throw new Error("OAuth connection secret expiresAt is invalid.");
  }
  return Object.freeze({
    ...token,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(optionalText(value.resource, "OAuth secret resource")
      ? { resource: optionalText(value.resource, "OAuth secret resource")! }
      : {}),
    connectorAccountId,
    createdAt: requiredText(value.createdAt, "OAuth secret createdAt", 128),
    oauthProviderKey: oauthKey(value.oauthProviderKey, "OAuth secret oauthProviderKey"),
    organizationId,
    providerKey,
    schemaVersion: PLATFORM_OAUTH_SECRET_SCHEMA_VERSION,
    updatedAt: requiredText(value.updatedAt, "OAuth secret updatedAt", 128),
  });
}

export function platformOAuthConnectionCredentialReference(credentialId: Ulid, generation: number) {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("OAuth credential generation must be a non-negative safe integer.");
  }
  return Object.freeze({ credentialId, generation, store: "dynamodb-kms" as const });
}
