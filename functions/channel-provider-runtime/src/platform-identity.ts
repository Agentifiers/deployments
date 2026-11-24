import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import {
  Ulid,
  authorizePlatformHumanScope,
  organizationRoleAllows,
  makeDynamoDatabase,
  principalAuditActor,
  tableNamesFromEnvironment,
  type OrganizationAccess,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { required } from "./required-value.ts";

interface PlatformIdentityEvent {
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly pathParameters?: Readonly<Record<string, string | undefined>>;
  readonly requestContext?: {
    readonly authorizer?: {
      readonly jwt?: { readonly claims?: Readonly<Record<string, string>> };
    };
  };
}

export interface ChannelProviderScope {
  readonly environmentId: string;
  /** Set when a platform administrator was admitted under operator access; audits name it. */
  readonly operatorAccessGrantId?: string;
  readonly organizationId: string;
  readonly principalId: string;
  readonly projectId: string;
}

export type ChannelProviderScopeAuthorizer = (
  input: ChannelProviderScope & { readonly tokenSessionId?: Ulid },
) => Promise<OrganizationAccess>;

/** The audit actor for a write an administrator makes under operator access, if they do. */
export function operatorAccessAuditActor(scope: ChannelProviderScope) {
  return scope.operatorAccessGrantId
    ? principalAuditActor(scope.principalId, scope.operatorAccessGrantId)
    : undefined;
}

export class ChannelProviderIdentityError extends Error {
  constructor(
    readonly statusCode: 401 | 403,
    message: string,
    readonly code:
      | "operator_access_required"
      | "organization_sso_required"
      | "unauthorized" = "unauthorized",
  ) {
    super(message);
    this.name = "ChannelProviderIdentityError";
  }
}

function requiredIdentity(value: string | undefined, label: string) {
  const result = value?.trim();
  if (!result) throw new ChannelProviderIdentityError(401, `${label} is required.`);
  return result;
}

function header(event: PlatformIdentityEvent, name: string) {
  return Object.entries(event.headers ?? {}).find(
    ([candidate]) => candidate.toLowerCase() === name,
  )?.[1];
}

function permits(scopes: string | undefined, requiredScope: string) {
  const values = new Set((scopes ?? "").split(/\s+/u).filter(Boolean));
  const group = requiredScope.split(":", 1)[0];
  return (
    values.has("platform:*") ||
    values.has("platform:admin") ||
    values.has(requiredScope) ||
    values.has(`${group}:*`)
  );
}

let database: ReturnType<typeof makeDynamoDatabase> | undefined;

export function runtimeDatabase() {
  database ??= makeDynamoDatabase(
    DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    tableNamesFromEnvironment(),
  );
  return database;
}

const authorizeRuntimeScope: ChannelProviderScopeAuthorizer = ({ tokenSessionId, ...input }) =>
  authorizePlatformHumanScope(runtimeDatabase(), {
    environmentId: Schema.decodeUnknownSync(Ulid)(input.environmentId),
    organizationId: Schema.decodeUnknownSync(Ulid)(input.organizationId),
    principalId: Schema.decodeUnknownSync(Ulid)(input.principalId),
    projectId: Schema.decodeUnknownSync(Ulid)(input.projectId),
    ...(tokenSessionId ? { tokenSessionId } : {}),
  });

export async function channelProviderScope(
  event: PlatformIdentityEvent,
  authorizeScope: ChannelProviderScopeAuthorizer = authorizeRuntimeScope,
): Promise<ChannelProviderScope> {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const environmentId = required(event.pathParameters?.environmentId, "environmentId");
  if (!claims?.client_id) {
    const organizationId = requiredIdentity(claims?.organization_id, "organization_id claim");
    return {
      environmentId,
      organizationId,
      principalId: requiredIdentity(
        claims?.principal_id ?? claims?.sub ?? organizationId,
        "principal_id claim",
      ),
      projectId: requiredIdentity(claims?.project_id, "project_id claim"),
    };
  }
  if (!permits(claims.scope, "providers:write")) {
    throw new ChannelProviderIdentityError(403, "providers:write scope is required.");
  }
  const scope = {
    environmentId,
    organizationId: requiredIdentity(
      header(event, "x-deployments-organization"),
      "x-deployments-organization header",
    ),
    principalId: requiredIdentity(claims.sub, "sub claim"),
    projectId: requiredIdentity(
      header(event, "x-deployments-project"),
      "x-deployments-project header",
    ),
  };
  const claimedEnvironment = header(event, "x-deployments-environment");
  if (claimedEnvironment !== undefined && claimedEnvironment !== environmentId) {
    throw new ChannelProviderIdentityError(
      403,
      "x-deployments-environment does not match the requested environment.",
    );
  }
  const tokenSessionId = claims.sid;
  const access = await authorizeScope({
    ...scope,
    ...(Schema.is(Ulid)(tokenSessionId) ? { tokenSessionId } : {}),
  });
  switch (access.kind) {
    case "denied":
      throw new ChannelProviderIdentityError(403, "The requested tenant is not authorized.");
    case "sso-required":
      throw new ChannelProviderIdentityError(
        403,
        "The organization requires single sign-on.",
        "organization_sso_required",
      );
    case "operator-access-required":
      throw new ChannelProviderIdentityError(
        403,
        "Platform administrators need open operator access to this organization.",
        "operator_access_required",
      );
    case "member":
      if (!organizationRoleAllows(access.role, "resources.mutate")) {
        throw new ChannelProviderIdentityError(
          403,
          "Provider mutations require an organization owner or administrator.",
        );
      }
      return scope;
    case "platform-administrator":
      return { ...scope, operatorAccessGrantId: access.operatorAccess.grantId };
  }
}
