import {
  ConnectionCapabilityRecord,
  MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION,
  PersistenceError,
  ProviderApplicationRecord,
  ProviderConnectionRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";
import {
  VendorMcpConfigurationError,
  providerUsesNoCredential,
  vendorMcpCanonicalUrl,
  vendorMcpOAuthPins,
} from "@deployments-ai/providers";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import type { AdministrationInvocation } from "./administration-api.ts";
import type {
  AdministrationPersistenceContext,
  EnvironmentRecord,
} from "./administration-persistence.ts";
import {
  asObject,
  credentialGeneration,
  expectedVersion,
  id,
  metadata,
  projection,
  providerCredentialValues,
  recordOperations,
  secretValues,
  strings,
  text,
  vaultReference,
} from "./administration-persistence.ts";
import {
  vendorMcpCallbackUri,
  vendorMcpPreRegistration,
} from "./vendor-mcp-client-registration.ts";

export function makeProviderCredentialAdministration(context: AdministrationPersistenceContext) {
  const {
    dependencies,
    generateId,
    now,
    credentialValue,
    environment,
    getRecord,
    listAllRecordsConsistently,
    providerDefinition,
    assertScopes,
    createCredentiallessProviderConnection,
    write,
  } = context;

  async function createProviderApplication(invocation: AdministrationInvocation) {
    const scope = await environment(invocation);
    const body = asObject(invocation.body);
    const definition = providerDefinition(body.providerKey);
    if (definition.auth.kind !== "oauth") {
      throw new PersistenceError(
        "unprocessable",
        "invalid_auth_method",
        "Provider does not support OAuth applications.",
      );
    }
    const timestamp = now().toISOString();
    const vendorMcp = definition.route === "vendor_mcp";
    if (!vendorMcp && body.registration !== undefined) {
      throw new PersistenceError(
        "unprocessable",
        "registration_unsupported",
        "Only vendor MCP providers accept an OAuth client registration.",
      );
    }
    const redirectUris = strings(body.redirectUris, "redirectUris");
    const requestedScopes = strings(body.requestedScopes, "requestedScopes");
    const registration = vendorMcp
      ? vendorMcpPreRegistration(definition, timestamp, body.registration)
      : undefined;
    if (registration) {
      assertScopes(requestedScopes, vendorMcpOAuthPins(definition).authorization.scopes);
      const callback = dependencies.vendorMcp
        ? vendorMcpCallbackUri(dependencies.vendorMcp.publicOrigin, definition)
        : undefined;
      if (callback && !redirectUris.includes(callback)) {
        throw new PersistenceError(
          "unprocessable",
          "oauth_redirect_uri_mismatch",
          `OAuth application redirect URIs must include ${callback}.`,
        );
      }
    } else {
      assertScopes(requestedScopes, definition.authorizationScopes);
    }
    const ownerId = id(await generateId());
    // Public vendor MCP clients (`none`) authenticate with PKCE only and carry no secret.
    const prepared =
      registration?.tokenEndpointAuthMethod === "none" && body.clientSecret === undefined
        ? undefined
        : await credentialValue(async () =>
            dependencies.credentials.prepareWrite({
              identity: {
                credentialId: id(await generateId()),
                environmentId: scope.id,
                organizationId: scope.organizationId,
                ownerId,
                ownerType: "provider-application",
                projectId: scope.projectId,
                purpose: "provider-oauth-client-secret",
              },
              secret: {
                values: {
                  ...(body.credential === undefined
                    ? {}
                    : secretValues(body.credential, "credential")),
                  clientSecret: text(body.clientSecret, "clientSecret"),
                },
              },
            }),
          );
    const record = Schema.decodeUnknownSync(ProviderApplicationRecord)(
      withCanonicalRecordKeys({
        itemType: "provider-application",
        data: {
          clientId: text(body.clientId, "clientId"),
          ...(prepared ? { clientSecretRef: prepared.reference } : {}),
          createdAt: timestamp,
          displayName: text(body.displayName, "displayName"),
          environmentId: scope.id,
          id: ownerId,
          ...(body.metadata ? { metadata: metadata(body.metadata) } : {}),
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          providerKey: definition.key,
          redirectUris,
          ...(registration ? { registration } : {}),
          requestedScopes,
          status: "active",
          updatedAt: timestamp,
          version: 0,
        },
      }),
    );
    await write(
      invocation,
      [...(prepared ? [prepared.operation] : []), ...recordOperations(record, timestamp)],
      "provider-application.create",
    );
    return projection(record);
  }

  async function createProviderCredential(invocation: AdministrationInvocation) {
    const scope = await environment(invocation);
    const body = asObject(invocation.body);
    const definition = providerDefinition(body.providerKey);
    if (definition.auth.kind === "oauth") {
      throw new PersistenceError(
        "unprocessable",
        "invalid_auth_method",
        "OAuth providers must be connected through authorization.",
      );
    }
    const requestedResource =
      body.requestedResource === undefined
        ? undefined
        : text(body.requestedResource, "requestedResource");
    let oauthResource: string | undefined;
    if (definition.route === "vendor_mcp") {
      try {
        oauthResource = vendorMcpCanonicalUrl(definition, requestedResource);
      } catch (cause) {
        if (!(cause instanceof VendorMcpConfigurationError)) throw cause;
        throw new PersistenceError("unprocessable", "invalid_oauth_resource", cause.message);
      }
    } else if (requestedResource !== undefined) {
      throw new PersistenceError(
        "unprocessable",
        "requested_resource_unsupported",
        "Only vendor MCP providers accept requestedResource.",
      );
    }
    const timestamp = now().toISOString();
    const ownerId = id(await generateId());
    const scopes = definition.defaultScopes;
    const credentialless = providerUsesNoCredential(definition);
    if (definition.auth.kind === "none" && !credentialless) {
      throw new PersistenceError(
        "unprocessable",
        "invalid_auth_method",
        "Credentialless provider must be connected through its dedicated verification lifecycle.",
      );
    }
    if (credentialless && body.credential !== undefined) {
      throw new PersistenceError(
        "invalid-input",
        "invalid_secret",
        "Credentialless providers do not accept credential fields.",
      );
    }
    const prepared = credentialless
      ? undefined
      : await credentialValue(async () =>
          dependencies.credentials.prepareWrite({
            identity: {
              credentialId: id(await generateId()),
              environmentId: scope.id,
              organizationId: scope.organizationId,
              ownerId,
              ownerType: "provider-connection",
              projectId: scope.projectId,
              purpose: "provider-api",
            },
            secret: { scopes, values: providerCredentialValues(body.credential, definition) },
          }),
        );
    const record = Schema.decodeUnknownSync(ProviderConnectionRecord)(
      withCanonicalRecordKeys({
        itemType: "provider-connection",
        data: {
          authMethod: credentialless ? "none" : "static",
          createdAt: timestamp,
          ...(prepared ? { credentialRef: prepared.reference } : {}),
          displayMetadata: {
            ...metadata(body.metadata),
            displayName: text(body.displayName, "displayName"),
          },
          environmentId: scope.id,
          ...(credentialless ? { externalAccountId: ownerId, lastVerifiedAt: timestamp } : {}),
          id: ownerId,
          organizationId: scope.organizationId,
          projectId: scope.projectId,
          ...(oauthResource ? { oauthResource } : {}),
          providerKey: definition.key,
          scopes,
          status: "active",
          updatedAt: timestamp,
          version: 0,
        },
      }),
    );
    const capability = credentialless
      ? Schema.decodeUnknownSync(ConnectionCapabilityRecord)(
          withCanonicalRecordKeys({
            itemType: "connection-capability",
            data: {
              connectionId: ownerId,
              createdAt: timestamp,
              environmentId: scope.id,
              id: id(await generateId()),
              metadata: { method: "none" },
              organizationId: scope.organizationId,
              projectId: scope.projectId,
              providerKey: definition.key,
              scopes,
              status: "active",
              updatedAt: timestamp,
              verificationVersion: 0,
              version: 0,
            },
          }),
        )
      : undefined;
    if (capability) {
      await createCredentiallessProviderConnection(
        invocation,
        record,
        capability,
        id(await generateId()),
        timestamp,
      );
    } else {
      await write(
        invocation,
        [prepared!.operation, ...recordOperations(record, timestamp)],
        "provider-connection.create",
      );
    }
    return projection(record);
  }

  async function revokeActiveConnectionGrants(
    invocation: AdministrationInvocation,
    connection: Extract<PlatformRecord, { readonly itemType: "provider-connection" }>,
    timestamp: string,
  ) {
    const grantOperations: TransactionOperation[] = [];
    const grants = await listAllRecordsConsistently(
      invocation,
      "workspace-connection-authorization",
      (grant) =>
        grant.itemType === "workspace-connection-authorization" &&
        grant.data.connectionId === connection.data.id &&
        grant.data.status === "active",
    );
    for (const grant of grants) {
      const revoked = withCanonicalRecordKeys({
        itemType: "workspace-connection-authorization",
        data: {
          ...grant.data,
          status: "revoked",
          updatedAt: timestamp,
          version: grant.data.version + 1,
        },
      }) as EnvironmentRecord;
      grantOperations.push(...recordOperations(revoked, timestamp, grant));
    }
    for (
      let offset = 0;
      offset < grantOperations.length;
      offset += MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION
    ) {
      const chunk = grantOperations.slice(
        offset,
        offset + MAX_THREADLESS_STABLE_TENANT_MUTATIONS_PER_TRANSACTION,
      );
      const chunkKey = createHash("sha256")
        .update(
          JSON.stringify(
            chunk.map((operation) =>
              operation.kind === "condition-check"
                ? {
                    kind: operation.kind,
                    pk: operation.key.pk,
                    sk: operation.key.sk,
                  }
                : {
                    kind: operation.kind,
                    pk: operation.record.pk,
                    sk: operation.record.sk,
                  },
            ),
          ),
        )
        .digest("hex")
        .slice(0, 16);
      await write(invocation, chunk, `provider-connection.rotate-grants.${chunkKey}`);
    }
  }

  async function completeConnectionRotationCleanup(
    invocation: AdministrationInvocation,
    connection: Extract<PlatformRecord, { readonly itemType: "provider-connection" }>,
    timestamp: string,
  ) {
    let completed:
      | Extract<PlatformRecord, { readonly itemType: "provider-connection" }>
      | undefined;
    let completionAttempted = false;
    try {
      await revokeActiveConnectionGrants(invocation, connection, timestamp);
      const {
        rotationCleanupPending: _rotationCleanupPending,
        rotationCleanupRequestHash: _rotationCleanupRequestHash,
        ...completedData
      } = connection.data;
      completed = Schema.decodeUnknownSync(ProviderConnectionRecord)(
        withCanonicalRecordKeys({
          itemType: "provider-connection",
          data: {
            ...completedData,
            updatedAt: timestamp,
            version: connection.data.version + 1,
          },
        }),
      );
      completionAttempted = true;
      await write(
        invocation,
        recordOperations(completed, timestamp, connection),
        "provider-connection.rotate-complete",
      );
      return completed;
    } catch (cause) {
      if (
        cause instanceof PersistenceError &&
        cause.kind === "internal" &&
        cause.code === "ambiguous_write_outcome"
      ) {
        if (completionAttempted && completed) {
          let current: EnvironmentRecord;
          try {
            current = await getRecord(invocation, "provider-connection", connection.data.id);
          } catch {
            throw cause;
          }
          if (
            current.itemType === "provider-connection" &&
            current.data.rotationCleanupPending !== true &&
            current.data.version === completed.data.version &&
            JSON.stringify(current.data.credentialRef) ===
              JSON.stringify(completed.data.credentialRef)
          ) {
            return current;
          }
          if (
            current.itemType !== "provider-connection" ||
            current.data.rotationCleanupPending !== true ||
            current.data.version !== connection.data.version
          ) {
            throw cause;
          }
        }
        throw new PersistenceError(
          "internal",
          "persistence_error",
          "Credential rotation cleanup can be retried with the same idempotency key.",
        );
      }
      throw cause;
    }
  }

  function rotationCleanupRequestHash(invocation: AdministrationInvocation) {
    if (!invocation.idempotencyKey) return undefined;
    return createHash("sha256")
      .update(
        JSON.stringify({
          body: invocation.body,
          environmentId: invocation.scope.environmentId ?? "",
          idempotencyKey: invocation.idempotencyKey,
          principalId: invocation.identity?.principalId ?? "anonymous",
        }),
      )
      .digest("hex");
  }

  async function rotateCredential(
    invocation: AdministrationInvocation,
    itemType: "provider-application" | "provider-connection",
  ) {
    const previous = await getRecord(invocation, itemType);
    const body = asObject(invocation.body);
    const timestamp = now().toISOString();
    const previousData = previous.data as Readonly<Record<string, unknown>>;
    if (itemType === "provider-connection" && previousData.rotationCleanupPending === true) {
      if (previousData.rotationCleanupRequestHash !== rotationCleanupRequestHash(invocation)) {
        throw new PersistenceError(
          "conflict",
          "rotation_cleanup_pending",
          "Retry the pending credential rotation with its original idempotency key before starting a new rotation.",
        );
      }
      const completed = await completeConnectionRotationCleanup(
        invocation,
        previous as Extract<PlatformRecord, { readonly itemType: "provider-connection" }>,
        timestamp,
      );
      return projection(completed);
    }
    expectedVersion(body, previous.data.version);
    if (
      itemType === "provider-connection" &&
      ["oauth", "oauth2"].includes(String(previousData.authMethod).toLowerCase())
    ) {
      throw new PersistenceError(
        "unprocessable",
        "invalid_auth_method",
        "OAuth connections must be refreshed through OAuth authorization.",
      );
    }
    const field = itemType === "provider-application" ? "clientSecretRef" : "credentialRef";
    const reference = previousData[field] ? vaultReference(previousData[field]) : undefined;
    if (!reference) {
      throw new PersistenceError(
        "conflict",
        "credential_missing",
        "The resource has no credential.",
      );
    }
    const generation = credentialGeneration(reference);
    const connectionDefinition =
      itemType === "provider-connection" ? providerDefinition(previousData.providerKey) : undefined;
    const retainedApplicationValues =
      itemType === "provider-application"
        ? (
            await credentialValue(() =>
              dependencies.credentials.read({
                environmentId: previous.data.environmentId,
                expectedIdentity: {
                  ownerId: previous.data.id,
                  ownerType: "provider-application",
                  projectId: previous.data.projectId,
                  purpose: "provider-oauth-client-secret",
                },
                organizationId: previous.data.organizationId,
                reference,
              }),
            )
          ).values
        : undefined;
    const prepared = await credentialValue(async () =>
      dependencies.credentials.prepareWrite({
        ...(generation === undefined ? {} : { expectedGeneration: generation }),
        identity: {
          credentialId:
            "credentialId" in reference ? reference.credentialId : id(await generateId()),
          environmentId: previous.data.environmentId,
          organizationId: previous.data.organizationId,
          ownerId: previous.data.id,
          ownerType: itemType,
          projectId: previous.data.projectId,
          purpose:
            itemType === "provider-application" ? "provider-oauth-client-secret" : "provider-api",
        },
        secret: {
          ...(itemType === "provider-connection"
            ? { scopes: (previousData.scopes ?? []) as readonly string[] }
            : {}),
          values:
            itemType === "provider-application"
              ? {
                  ...retainedApplicationValues,
                  ...(body.credential === undefined
                    ? {}
                    : secretValues(body.credential, "credential")),
                  clientSecret: text(body.clientSecret, "clientSecret"),
                }
              : providerCredentialValues(body.credential, connectionDefinition!),
        },
      }),
    );
    const nextData =
      itemType === "provider-connection"
        ? (() => {
            const {
              externalAccountId: _externalAccountId,
              externalAccountName: _externalAccountName,
              lastVerifiedAt: _lastVerifiedAt,
              ...unverified
            } = previous.data as Extract<
              PlatformRecord,
              { readonly itemType: "provider-connection" }
            >["data"];
            return {
              ...unverified,
              [field]: prepared.reference,
              rotationCleanupPending: true,
              rotationCleanupRequestHash: rotationCleanupRequestHash(invocation),
              status: "reauthorization-required",
              updatedAt: timestamp,
              version: previous.data.version + 1,
            };
          })()
        : {
            ...previous.data,
            [field]: prepared.reference,
            updatedAt: timestamp,
            version: previous.data.version + 1,
          };
    const next = withCanonicalRecordKeys({ itemType, data: nextData }) as EnvironmentRecord;
    const operations: TransactionOperation[] = [
      prepared.operation,
      ...recordOperations(next, timestamp, previous),
    ];
    if (itemType === "provider-connection") {
      const capabilities = await listAllRecordsConsistently(
        { ...invocation, query: { limit: 100 } },
        "connection-capability",
        (candidate) =>
          candidate.itemType === "connection-capability" &&
          candidate.data.connectionId === previous.data.id &&
          candidate.data.status === "active",
      );
      for (const capability of capabilities) {
        const stale = withCanonicalRecordKeys({
          itemType: "connection-capability",
          data: {
            ...capability.data,
            status: "stale",
            updatedAt: timestamp,
            version: capability.data.version + 1,
          },
        }) as EnvironmentRecord;
        operations.push(...recordOperations(stale, timestamp, capability));
      }
      let pendingConnection = next as Extract<
        PlatformRecord,
        { readonly itemType: "provider-connection" }
      >;
      try {
        await write(invocation, operations, `${itemType}.rotate`);
      } catch (cause) {
        if (
          !(cause instanceof PersistenceError) ||
          cause.kind !== "internal" ||
          cause.code !== "ambiguous_write_outcome"
        ) {
          throw cause;
        }
        let current: EnvironmentRecord;
        try {
          current = await getRecord(invocation, "provider-connection", previous.data.id);
        } catch {
          throw cause;
        }
        if (
          current.itemType === "provider-connection" &&
          current.data.rotationCleanupPending === true &&
          current.data.rotationCleanupRequestHash ===
            pendingConnection.data.rotationCleanupRequestHash &&
          current.data.version === pendingConnection.data.version
        ) {
          pendingConnection = current;
        } else if (
          current.data.status === previous.data.status &&
          current.data.version === previous.data.version
        ) {
          throw new PersistenceError(
            "internal",
            "persistence_error",
            "Credential rotation can be retried with the same idempotency key.",
          );
        } else {
          throw cause;
        }
      }
      const completed = await completeConnectionRotationCleanup(
        invocation,
        pendingConnection,
        timestamp,
      );
      return projection(completed);
    } else {
      await write(invocation, operations, `${itemType}.rotate`);
    }
    return projection(next);
  }
  return {
    createProviderApplication,
    createProviderCredential,
    revokeActiveConnectionGrants,
    completeConnectionRotationCleanup,
    rotationCleanupRequestHash,
    rotateCredential,
  };
}
