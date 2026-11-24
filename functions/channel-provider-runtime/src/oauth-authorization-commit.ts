import {
  CredentialVaultError,
  type CredentialVaultPreparedMutation,
  type CredentialVaultService,
} from "@deployments-ai/credential-vault";
import {
  AuditEventRecord,
  OAuthAuthorizationAttemptRecord,
  ProviderConnectionRecord,
  UNIQUE_CLAIM_CONDITION,
  principalAuditActor,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { makeProviderSemanticEventRecord } from "@deployments-ai/events";
import { Schema } from "effect";
import { createHash } from "node:crypto";

import type { OAuthRuntimeDependencies, OAuthScope } from "./oauth-runtime-dependencies.ts";
import { requiredUniqueClaim } from "./oauth-validation.ts";
import { required } from "./required-value.ts";
import { vaultReference } from "./runtime.ts";

export type OAuthAuthorizationAttempt = typeof OAuthAuthorizationAttemptRecord.Type;
export type ProviderConnection = typeof ProviderConnectionRecord.Type;
type ProviderConnectionData = ProviderConnection["data"];

/**
 * PKCE verifier for an attempt: the vaulted random verifier, or the legacy state-derived
 * verifier for attempts created before verifiers were vaulted (`allowLegacy`).
 */
export async function attemptPkceVerifier(
  vault: CredentialVaultService,
  scope: OAuthScope,
  attempt: OAuthAuthorizationAttempt,
  state: string,
  allowLegacy: boolean,
) {
  if (!attempt.data.pkceSecretRef) {
    if (!allowLegacy) throw new Error("PKCE verifier is required.");
    return createHash("sha256").update(`oauth-pkce:${state}`).digest("base64url");
  }
  const pkceSecret = await vault.read({
    environmentId: scope.environmentId as Ulid,
    expectedIdentity: {
      ownerId: attempt.data.id,
      ownerType: "oauth-authorization-attempt",
      projectId: scope.projectId as Ulid,
      purpose: "oauth-pkce-verifier",
    },
    organizationId: scope.organizationId as Ulid,
    reference: vaultReference(attempt.data.pkceSecretRef),
  });
  return required(pkceSecret.values.verifier, "PKCE verifier");
}

export interface AuthorizedConnectionInput {
  readonly attempt: OAuthAuthorizationAttempt;
  /** Connection data without tenant scope, timestamps, credential reference, or version. */
  readonly connection: Omit<
    ProviderConnectionData,
    | "createdAt"
    | "credentialRef"
    | "environmentId"
    | "organizationId"
    | "projectId"
    | "updatedAt"
    | "version"
  >;
  readonly credential: CredentialVaultPreparedMutation;
  readonly now: string;
  readonly scope: OAuthScope;
  readonly vault: CredentialVaultService;
}

/**
 * One transaction: vault credential (generation 0), PKCE verifier revocation, connection
 * create + external-account claim, completed attempt, audit, and `provider.connection.authorized`.
 */
export async function persistAuthorizedConnection(
  dependencies: OAuthRuntimeDependencies,
  input: AuthorizedConnectionInput,
) {
  const { attempt, now, scope, vault } = input;
  const connectionId = input.connection.id;
  const connection = Schema.decodeUnknownSync(ProviderConnectionRecord)(
    withCanonicalRecordKeys({
      itemType: "provider-connection" as const,
      data: {
        ...input.connection,
        createdAt: now,
        credentialRef: input.credential.reference,
        environmentId: scope.environmentId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        updatedAt: now,
        version: 0,
      },
    }),
  );
  const completed = Schema.decodeUnknownSync(OAuthAuthorizationAttemptRecord)(
    withCanonicalRecordKeys({
      itemType: "oauth-authorization-attempt" as const,
      data: {
        ...attempt.data,
        completedAt: now,
        connectionId,
        status: "completed" as const,
        version: attempt.data.version + 1,
      },
      ttl: attempt.ttl,
    }),
  );
  const connectionClaim = requiredUniqueClaim(connection, connection.data.createdAt);
  const semantic = makeProviderSemanticEventRecord({
    aggregateId: connectionId,
    aggregateType: "provider-connection",
    aggregateVersion: 1,
    environmentId: scope.environmentId as Ulid,
    eventId: await dependencies.id(),
    eventType: "provider.connection.authorized",
    occurredAt: now,
    organizationId: scope.organizationId as Ulid,
    payload: { connectionId, providerKey: connection.data.providerKey },
    projectId: scope.projectId as Ulid,
  });
  const audit = Schema.decodeUnknownSync(AuditEventRecord)(
    withCanonicalRecordKeys({
      itemType: "audit-event" as const,
      data: {
        action: "provider.oauth.authorized",
        actor: principalAuditActor(attempt.data.principalId, attempt.data.operatorAccessGrantId),
        environmentId: scope.environmentId,
        eventId: await dependencies.id(),
        occurredAt: now,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        resourceId: connectionId,
        resourceType: "provider-connection",
      },
    }),
  );
  let revokedPkce: CredentialVaultPreparedMutation | undefined;
  if (attempt.data.pkceSecretRef) {
    try {
      revokedPkce = await vault.prepareRevoke({
        environmentId: scope.environmentId as Ulid,
        organizationId: scope.organizationId as Ulid,
        reference: vaultReference(attempt.data.pkceSecretRef),
      });
    } catch (cause) {
      if (
        !(cause instanceof CredentialVaultError) ||
        (cause.code !== "revoked" && cause.code !== "not-found")
      ) {
        throw cause;
      }
      // The verifier was already read and the provider code was consumed. Expiration or prior
      // cleanup is terminal for the PKCE secret and must not discard the authorized connection.
    }
  }
  await dependencies.commitAuthorization(
    scope,
    [
      input.credential.operation,
      ...(revokedPkce ? [revokedPkce.operation] : []),
      {
        conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        kind: "put",
        record: connection,
      },
      { conditionExpression: UNIQUE_CLAIM_CONDITION, kind: "put", record: connectionClaim },
      { kind: "put", previousRecord: attempt, record: completed },
      {
        conditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        kind: "put",
        record: audit,
      },
    ],
    [semantic],
  );
  return connection;
}
