import type {
  OrganizationRole,
  PlatformRecord,
  RunInitiatingCaller,
  Ulid,
} from "@deployments-ai/db";
import { credentialScopePermits, platformScopePermits } from "@deployments-ai/identity/scopes";
import { RuntimeApiError } from "./runtime-api-error.ts";

type Credential = Extract<PlatformRecord, { readonly itemType: "api-credential" }>;
type ServiceAccount = Extract<PlatformRecord, { readonly itemType: "service-account" }>;

/** The single environment every runtime request operates in, whichever way it authenticated. */
export interface RuntimeApiScope {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
}

/** A hashed service-account API key; its scope is the credential's environment. */
export interface RuntimeApiCredentialPrincipal {
  readonly credential: Credential;
  readonly kind: "api-credential";
  readonly scope: RuntimeApiScope;
  readonly serviceAccount: ServiceAccount;
}

/**
 * A person holding a platform bearer JWT; its scope is the environment named by the tenant
 * headers, admitted through live organization membership or the platform administrator role.
 */
export interface RuntimeHumanPrincipal {
  readonly kind: "human";
  /** The operator access grant a platform administrator without membership acts under. */
  readonly operatorAccessGrantId?: Ulid;
  readonly organizationRole?: OrganizationRole;
  readonly platformAdministrator: boolean;
  readonly principalId: Ulid;
  readonly scope: RuntimeApiScope;
  readonly scopes: readonly string[];
}

export type RuntimeApiPrincipal = RuntimeApiCredentialPrincipal | RuntimeHumanPrincipal;

/** Verifies a platform bearer JWT and admits its holder to the environment in the headers. */
export type RuntimeHumanAuthenticator = (
  token: string,
  requestHeaders: Readonly<Record<string, string | undefined>>,
) => Promise<RuntimeHumanPrincipal>;

export function requireScope(principal: RuntimeApiPrincipal, required: string) {
  const allowed =
    principal.kind === "human"
      ? platformScopePermits(principal.scopes, required)
      : credentialScopePermits(principal.credential.data.scopes, required) &&
        credentialScopePermits(principal.serviceAccount.data.scopes, required);
  if (!allowed) {
    throw new RuntimeApiError(403, "insufficient_scope", `The credential requires ${required}.`);
  }
}

/** The identity attribution and ownership fields record for this caller. */
export function principalActorId(principal: RuntimeApiPrincipal): Ulid {
  return principal.kind === "human" ? principal.principalId : principal.serviceAccount.data.id;
}

/** Actor reference for persisted records and semantic events. */
export function recordActor(principal: RuntimeApiPrincipal) {
  return {
    id: principalActorId(principal),
    ...(principal.kind === "human" && principal.operatorAccessGrantId
      ? { operatorAccessGrantId: principal.operatorAccessGrantId }
      : {}),
    type: principal.kind === "human" ? ("principal" as const) : ("service-account" as const),
  };
}

/** Actor reference for live thread stream events. */
export function streamActor(principal: RuntimeApiPrincipal) {
  return {
    id: principalActorId(principal),
    type: principal.kind === "human" ? ("user" as const) : ("service" as const),
  };
}

export function runInitiatingCaller(principal: RuntimeApiPrincipal): RunInitiatingCaller {
  return principal.kind === "human"
    ? { principalId: principal.principalId, scopes: principal.scopes, type: "principal" }
    : {
        apiCredentialId: principal.credential.data.id,
        serviceAccountId: principal.serviceAccount.data.id,
        type: "service-account",
      };
}
