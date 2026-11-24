import type { CredentialVaultService } from "@deployments-ai/credential-vault";
import {
  makeDynamoDatabase,
  makeOrganizationHoldReader,
  type OrganizationHoldReader,
  type PlatformRecord,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { transactWithSemanticEvents, type SemanticEventRecordValue } from "@deployments-ai/events";
import {
  codeProviderDefinitionRegistry,
  PLATFORM_OAUTH_PUBLIC_ORIGIN_ENV,
  PLATFORM_OAUTH_RETURN_ORIGINS_ENV,
  platformOAuthReturnOrigins,
  type PlatformOAuthAppRegistry,
  type ProviderDefinitionRegistry,
} from "@deployments-ai/providers";

import {
  commitCredentialOwnershipMutation,
  commitProviderConnectionReauthorizationRequired,
  type CredentialOwnershipMutation,
  type ProviderConnectionReauthorizationRequired,
} from "./credential-ownership.ts";
import { getRecord, id, registry } from "./oauth-validation.ts";
import { runtimeDatabase } from "./platform-identity.ts";
import { runtimeCredentialVault, runtimeScopedDocumentClient } from "./runtime.ts";

export interface OAuthScope {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

export type OAuthFetch = (input: string, init: RequestInit) => Promise<Response>;

/** I/O seams shared by the OAuth callback, refresh, revoke, CIMD, and internal refresh paths. */
export interface OAuthRuntimeDependencies {
  /** Persists the authorized connection, its claim, the completed attempt, audit, and event. */
  readonly commitAuthorization: (
    scope: OAuthScope,
    operations: readonly TransactionOperation[],
    events: readonly SemanticEventRecordValue[],
  ) => Promise<void>;
  readonly commitOwnership: (mutation: CredentialOwnershipMutation) => Promise<void>;
  readonly definitions: () => ProviderDefinitionRegistry;
  readonly fetch: OAuthFetch;
  readonly loadControlRecord: (
    scope: OAuthScope,
    itemType: string,
    itemId: string,
  ) => Promise<PlatformRecord>;
  readonly id: () => Promise<Ulid>;
  readonly markReauthorizationRequired: (
    input: ProviderConnectionReauthorizationRequired,
  ) => Promise<void>;
  readonly now: () => Date;
  /** OpenTofu `PLATFORM_OAUTH_APPS_JSON` registry (platform_oauth only). */
  readonly platformApps: () => PlatformOAuthAppRegistry;
  /** `PLATFORM_OAUTH_PUBLIC_ORIGIN`; required for vendor MCP OAuth and the CIMD document. */
  readonly publicOrigin: () => string | undefined;
  /** `PLATFORM_OAUTH_RETURN_ORIGINS`; origins an authorization `returnTo` may target. */
  readonly returnOrigins: () => readonly string[];
  /** Organization holds; they decide the JWT authorize, refresh, and revoke routes. */
  readonly standing: OrganizationHoldReader;
  readonly vault: (scope: OAuthScope) => Promise<CredentialVaultService>;
}

export function defaultOAuthRuntimeDependencies(): OAuthRuntimeDependencies {
  return {
    commitAuthorization: async (scope, operations, events) => {
      const database = makeDynamoDatabase(await runtimeScopedDocumentClient(scope, "writer"));
      await transactWithSemanticEvents(database, operations, events);
    },
    commitOwnership: commitCredentialOwnershipMutation,
    definitions: codeProviderDefinitionRegistry,
    fetch: (input, init) => fetch(input, init),
    loadControlRecord: getRecord,
    id,
    markReauthorizationRequired: commitProviderConnectionReauthorizationRequired,
    now: () => new Date(),
    platformApps: registry,
    publicOrigin: () => process.env[PLATFORM_OAUTH_PUBLIC_ORIGIN_ENV]?.trim() || undefined,
    returnOrigins: () => platformOAuthReturnOrigins(process.env[PLATFORM_OAUTH_RETURN_ORIGINS_ENV]),
    standing: makeOrganizationHoldReader(runtimeDatabase()),
    vault: (scope) => runtimeCredentialVault(scope, "writer"),
  };
}
