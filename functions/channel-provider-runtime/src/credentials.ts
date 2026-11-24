import {
  assertNoReservedProviderOAuthMaterialFields,
  CredentialVaultError,
  type CredentialVaultOwnerType,
  type CredentialVaultService,
} from "@deployments-ai/credential-vault";
import { makeOrganizationHoldReader, type OrganizationHoldReader } from "@deployments-ai/db";
import type { ApiActivity } from "@deployments-ai/organization-admission";

import { runtimeCredentialVault } from "./runtime.ts";
import {
  commitCredentialOwnershipMutation,
  type CredentialOwnerType,
} from "./credential-ownership.ts";
import { standingRefusal } from "./organization-standing.ts";
import {
  channelProviderScope,
  operatorAccessAuditActor,
  ChannelProviderIdentityError,
  runtimeDatabase,
  type ChannelProviderScopeAuthorizer,
} from "./platform-identity.ts";

export interface CredentialApiEvent {
  readonly body?: string | null;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly pathParameters?: Readonly<Record<string, string | undefined>>;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>>;
  readonly requestContext?: {
    readonly authorizer?: {
      readonly jwt?: { readonly claims?: Readonly<Record<string, string>> };
    };
    readonly http?: { readonly method?: string };
    readonly requestId?: string;
  };
}

export interface CredentialApiDependencies {
  readonly authorizePlatformScope?: ChannelProviderScopeAuthorizer;
  readonly commit?: typeof commitCredentialOwnershipMutation;
  readonly standing?: OrganizationHoldReader;
  readonly vault?: CredentialVaultService;
}

class CredentialApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CredentialApiError";
  }
}

const ownerTypes = new Set<CredentialVaultOwnerType>([
  "channel-binding",
  "mcp-server",
  "provider-application",
  "provider-connection",
  "webhook-endpoint",
]);

const CREDENTIAL_ACTIVITY: Readonly<Record<string, ApiActivity | undefined>> = {
  DELETE: "api.remediate",
  POST: "api.write",
  PUT: "api.write",
};

function response(statusCode: number, body?: unknown) {
  return {
    statusCode,
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
  };
}

function required(value: string | undefined, label: string) {
  const normalized = value?.trim();
  if (!normalized) throw new CredentialApiError(400, "invalid_request", `${label} is required.`);
  return normalized;
}

function body(event: CredentialApiEvent) {
  const value = JSON.parse(event.body ?? "{}") as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CredentialApiError(
      400,
      "invalid_request",
      "Credential request body must be an object.",
    );
  }
  return value as Record<string, unknown>;
}

function stringRecord(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CredentialApiError(400, "invalid_request", `${label} must be an object.`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (typeof entry !== "string") {
        throw new CredentialApiError(400, "invalid_request", `${label}.${key} must be a string.`);
      }
      return [key, entry];
    }),
  );
}

function ownerType(value: unknown): CredentialVaultOwnerType {
  const normalized = required(typeof value === "string" ? value : undefined, "ownerType");
  if (!ownerTypes.has(normalized as CredentialVaultOwnerType)) {
    throw new CredentialApiError(400, "invalid_request", "ownerType is not supported.");
  }
  return normalized as CredentialVaultOwnerType;
}

function stringList(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new CredentialApiError(400, "invalid_request", `${label} must be a string array.`);
  }
  return value as string[];
}

function generation(value: unknown, label: string) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new CredentialApiError(
      400,
      "invalid_request",
      `${label} must be a non-negative safe integer.`,
    );
  }
  return parsed;
}

function errorResponse(cause: unknown) {
  if (cause instanceof ChannelProviderIdentityError) {
    return response(cause.statusCode, { error: cause.code });
  }
  if (cause instanceof CredentialApiError) {
    return response(cause.statusCode, { error: cause.code });
  }
  if (cause instanceof CredentialVaultError) {
    const statusCode = cause.code === "conflict" ? 409 : cause.code === "not-found" ? 404 : 400;
    return response(statusCode, { error: `credential_${cause.code}` });
  }
  return response(400, { error: "invalid_credential_request" });
}

export async function handleCredentialApi(
  event: CredentialApiEvent,
  dependencies: CredentialApiDependencies = {},
) {
  try {
    const scope = await channelProviderScope(event, dependencies.authorizePlatformScope);
    const { environmentId, organizationId, projectId } = scope;
    const actor = operatorAccessAuditActor(scope);
    const credentialId = required(event.pathParameters?.credentialId, "credentialId");
    const method = event.requestContext?.http?.method?.toUpperCase();
    const activity = method && CREDENTIAL_ACTIVITY[method];
    if (!activity) return response(405, { error: "method_not_allowed" });
    const refusal = await standingRefusal({
      activity,
      organizationId,
      requestId: event.requestContext?.requestId,
      standing: dependencies.standing ?? makeOrganizationHoldReader(runtimeDatabase()),
    });
    if (refusal) return refusal;
    const vault =
      dependencies.vault ??
      (await runtimeCredentialVault({ environmentId, organizationId, projectId }, "writer"));
    const commit = dependencies.commit ?? commitCredentialOwnershipMutation;
    if (method === "DELETE") {
      const expectedGeneration = generation(event.queryStringParameters?.generation, "generation");
      const request = {
        environmentId: environmentId as never,
        organizationId: organizationId as never,
        reference: {
          credentialId: credentialId as never,
          generation: expectedGeneration,
          store: "dynamodb-kms",
        },
      } as const;
      if (dependencies.vault && !dependencies.commit) await vault.revoke(request);
      else {
        await commit({
          action: "revoked",
          ...(actor ? { actor } : {}),
          ownerId: required(event.queryStringParameters?.ownerId, "ownerId"),
          ownerType: ownerType(event.queryStringParameters?.ownerType) as CredentialOwnerType,
          prepared: await vault.prepareRevoke(request),
          scope: { environmentId, organizationId, projectId },
        });
      }
      return response(204);
    }
    const input = body(event);
    const expectedGeneration =
      method === "PUT" ? generation(input.expectedGeneration, "expectedGeneration") : undefined;
    const scopes = stringList(input.scopes, "scopes");
    const values = stringRecord(input.values, "values");
    assertNoReservedProviderOAuthMaterialFields(values);
    const writeRequest = {
      ...(expectedGeneration === undefined ? {} : { expectedGeneration }),
      identity: {
        credentialId: credentialId as never,
        environmentId: environmentId as never,
        organizationId: organizationId as never,
        ownerId: required(input.ownerId as string | undefined, "ownerId") as never,
        ownerType: ownerType(input.ownerType),
        projectId: projectId as never,
        purpose: required(input.purpose as string | undefined, "purpose"),
      },
      secret: {
        ...(typeof input.expiresAt === "string" ? { expiresAt: input.expiresAt } : {}),
        ...(input.metadata === undefined
          ? {}
          : { metadata: stringRecord(input.metadata, "metadata") }),
        ...(scopes === undefined ? {} : { scopes }),
        values,
      },
    } as const;
    let reference;
    if (dependencies.vault && !dependencies.commit) reference = await vault.write(writeRequest);
    else {
      const prepared = await vault.prepareWrite(writeRequest);
      await commit({
        action: method === "POST" ? "created" : "rotated",
        ...(actor ? { actor } : {}),
        ownerId: writeRequest.identity.ownerId,
        ownerType: writeRequest.identity.ownerType as CredentialOwnerType,
        prepared,
        scope: { environmentId, organizationId, projectId },
      });
      reference = prepared.reference;
    }
    return response(method === "POST" ? 201 : 200, { reference });
  } catch (cause) {
    const nested = cause && typeof cause === "object" && "cause" in cause ? cause.cause : undefined;
    console.error("Credential API request failed.", {
      errorType: cause instanceof Error ? cause.name : "UnknownError",
      message: cause instanceof Error ? cause.message : undefined,
      nestedType:
        nested instanceof Error
          ? nested.name
          : nested && typeof nested === "object" && "name" in nested
            ? String(nested.name)
            : undefined,
      operation:
        cause && typeof cause === "object" && "operation" in cause
          ? String(cause.operation)
          : undefined,
      table:
        cause && typeof cause === "object" && "table" in cause ? String(cause.table) : undefined,
    });
    return errorResponse(cause);
  }
}

export const handler = handleCredentialApi;
