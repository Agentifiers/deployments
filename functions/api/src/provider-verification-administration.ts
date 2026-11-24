import {
  ConnectionCapabilityRecord,
  ConnectionVerificationRecord,
  PersistenceError,
  ProviderConnectionRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type { AdministrationInvocation } from "./administration-api.ts";
import type { AdministrationPersistenceContext } from "./administration-persistence.ts";
import {
  id,
  metadata,
  projection,
  recordOperations,
  vaultReference,
} from "./administration-persistence.ts";
import { AdministrationProviderVerificationError } from "./provider-verification.ts";
import { verifyVendorMcpDiscovery } from "./provider-verification-mcp.ts";
import { requireVendorMcpDependencies } from "./vendor-mcp-administration-errors.ts";
import {
  readVendorMcpConnectionCredential,
  type ProviderConnection,
} from "./vendor-mcp-connection-credential.ts";

export function makeProviderVerificationAdministration(context: AdministrationPersistenceContext) {
  const {
    dependencies,
    generateId,
    now,
    credentialValue,
    getRecord,
    listAllRecords,
    listAllRecordsConsistently,
    providerDefinition,
    assertScopes,
    write,
  } = context;

  async function requestVerification(invocation: AdministrationInvocation) {
    const requested = (await getRecord(invocation, "provider-connection")) as ProviderConnection;
    if (
      !["active", "reauthorization-required"].includes(requested.data.status) ||
      !requested.data.credentialRef ||
      requested.data.rotationCleanupPending === true ||
      (requested.data.status === "reauthorization-required" &&
        ["oauth", "oauth2"].includes(requested.data.authMethod.toLowerCase()))
    ) {
      throw new PersistenceError(
        "unprocessable",
        "connection_not_verifiable",
        "Connection does not have an active credential.",
      );
    }
    const definition = providerDefinition(requested.data.providerKey);
    // Vendor MCP connections are refreshed on demand before the credential is pinned.
    const vendorMcp =
      definition.route === "vendor_mcp"
        ? await readVendorMcpConnectionCredential(context, invocation, requested)
        : undefined;
    const connection = vendorMcp?.connection ?? requested;
    const credentialReference = vaultReference(connection.data.credentialRef);
    const credential =
      vendorMcp?.credential ??
      (await credentialValue(() =>
        dependencies.credentials.read({
          environmentId: connection.data.environmentId,
          expectedIdentity: {
            ownerId: connection.data.id,
            ownerType: "provider-connection",
            projectId: connection.data.projectId,
            purpose: ["oauth", "oauth2"].includes(connection.data.authMethod.toLowerCase())
              ? "provider-oauth-token"
              : "provider-api",
          },
          organizationId: connection.data.organizationId,
          reference: credentialReference,
        }),
      ));
    const timestamp = now().toISOString();
    const record = Schema.decodeUnknownSync(ConnectionVerificationRecord)(
      withCanonicalRecordKeys({
        itemType: "connection-verification",
        data: {
          connectionId: connection.data.id,
          createdAt: timestamp,
          environmentId: connection.data.environmentId,
          generationPin: { credentialGeneration: credentialReference.generation },
          id: id(await generateId()),
          ...(invocation.idempotencyKey ? { idempotencyKey: invocation.idempotencyKey } : {}),
          organizationId: connection.data.organizationId,
          projectId: connection.data.projectId,
          providerKey: connection.data.providerKey,
          status: "pending",
          updatedAt: timestamp,
          version: 0,
        },
      }),
    );
    await write(invocation, recordOperations(record, timestamp), "connection-verification.request");
    let providerProbeStarted = false;
    let providerProbeCompleted = false;
    try {
      providerProbeStarted = true;
      const result = vendorMcp
        ? await verifyVendorMcpDiscovery(
            requireVendorMcpDependencies(dependencies).mcpClient,
            vendorMcp,
          )
        : await dependencies.providerVerification.verify({
            connection: {
              ...(connection.data.externalAccountId
                ? { externalAccountId: connection.data.externalAccountId }
                : {}),
              ...(connection.data.externalAccountName
                ? { externalAccountName: connection.data.externalAccountName }
                : {}),
              id: connection.data.id,
              scopes: connection.data.scopes,
            },
            credential,
            definition,
          });
      providerProbeCompleted = true;
      assertScopes(result.scopes, definition.defaultScopes, "Verified scopes");
      const completedAt = now().toISOString();
      const verified = Schema.decodeUnknownSync(ConnectionVerificationRecord)(
        withCanonicalRecordKeys({
          itemType: "connection-verification",
          data: {
            ...record.data,
            completedAt,
            result: {
              ...(result.externalAccountId ? { externalAccountId: result.externalAccountId } : {}),
              ...(result.externalAccountName
                ? { externalAccountName: result.externalAccountName }
                : {}),
              ...metadata(result.metadata),
              scopes: [...result.scopes],
            },
            status: "verified",
            updatedAt: completedAt,
            version: record.data.version + 1,
          },
        }),
      );
      const existingCapabilities = await listAllRecordsConsistently(
        { ...invocation, query: { limit: 100 } },
        "connection-capability",
        (candidate) =>
          candidate.itemType === "connection-capability" &&
          candidate.data.connectionId === connection.data.id,
      );
      const previousCapability = existingCapabilities[0] as
        | Extract<PlatformRecord, { readonly itemType: "connection-capability" }>
        | undefined;
      const capability = Schema.decodeUnknownSync(ConnectionCapabilityRecord)(
        withCanonicalRecordKeys({
          itemType: "connection-capability",
          data: {
            connectionId: connection.data.id,
            createdAt: previousCapability?.data.createdAt ?? completedAt,
            environmentId: connection.data.environmentId,
            id: previousCapability?.data.id ?? id(await generateId()),
            ...(result.metadata ? { metadata: metadata(result.metadata) } : {}),
            organizationId: connection.data.organizationId,
            projectId: connection.data.projectId,
            providerKey: connection.data.providerKey,
            scopes: [...result.scopes],
            status: "active",
            updatedAt: completedAt,
            verificationVersion: verified.data.version,
            version: (previousCapability?.data.version ?? -1) + 1,
          },
        }),
      );
      const verifiedConnection = Schema.decodeUnknownSync(ProviderConnectionRecord)(
        withCanonicalRecordKeys({
          itemType: "provider-connection",
          data: {
            ...connection.data,
            ...(["oauth", "oauth2"].includes(connection.data.authMethod.toLowerCase())
              ? {
                  authorizationScopes:
                    credential.scopes ??
                    connection.data.authorizationScopes ??
                    connection.data.scopes,
                }
              : {}),
            externalAccountId: result.externalAccountId ?? connection.data.id,
            ...(result.externalAccountName
              ? { externalAccountName: result.externalAccountName }
              : {}),
            lastVerifiedAt: completedAt,
            scopes: [...result.scopes],
            status: "active",
            updatedAt: completedAt,
            version: connection.data.version + 1,
          },
        }),
      );
      await write(
        invocation,
        [
          ...recordOperations(verified, completedAt, record),
          ...recordOperations(capability, completedAt, previousCapability),
          ...recordOperations(verifiedConnection, completedAt, connection),
        ],
        "connection-verification.complete",
      );
      return projection(verified);
    } catch (cause) {
      if (!providerProbeStarted) throw cause;
      if (providerProbeCompleted) {
        const completedAt = now().toISOString();
        const failed = Schema.decodeUnknownSync(ConnectionVerificationRecord)(
          withCanonicalRecordKeys({
            itemType: "connection-verification",
            data: {
              ...record.data,
              completedAt,
              error: {
                code: "verification_completion_failed",
                message: "Provider verification could not be persisted.",
              },
              status: "failed",
              updatedAt: completedAt,
              version: record.data.version + 1,
            },
          }),
        );
        try {
          await write(
            invocation,
            recordOperations(failed, completedAt, record),
            "connection-verification.completion-fail",
          );
        } catch {
          // Preserve the original completion failure; the pending record remains auditable by ID.
        }
        throw cause;
      }
      const completedAt = now().toISOString();
      const failed = Schema.decodeUnknownSync(ConnectionVerificationRecord)(
        withCanonicalRecordKeys({
          itemType: "connection-verification",
          data: {
            ...record.data,
            completedAt,
            error: {
              code: "provider_verification_failed",
              message: "Provider credential verification failed.",
            },
            status: "failed",
            updatedAt: completedAt,
            version: record.data.version + 1,
          },
        }),
      );
      const operations = [...recordOperations(failed, completedAt, record)];
      if (cause instanceof AdministrationProviderVerificationError && cause.definitive) {
        const capabilities = await listAllRecords(
          invocation,
          "connection-capability",
          (candidate) =>
            candidate.itemType === "connection-capability" &&
            candidate.data.connectionId === connection.data.id &&
            candidate.data.status === "active",
        );
        for (const candidate of capabilities) {
          const capability = (await getRecord(
            invocation,
            "connection-capability",
            id(String(candidate.id)),
          )) as Extract<PlatformRecord, { readonly itemType: "connection-capability" }>;
          const stale = Schema.decodeUnknownSync(ConnectionCapabilityRecord)(
            withCanonicalRecordKeys({
              itemType: "connection-capability",
              data: {
                ...capability.data,
                status: "stale",
                updatedAt: completedAt,
                version: capability.data.version + 1,
              },
            }),
          );
          operations.push(...recordOperations(stale, completedAt, capability));
        }
        const staleConnection = Schema.decodeUnknownSync(ProviderConnectionRecord)(
          withCanonicalRecordKeys({
            itemType: "provider-connection",
            data: {
              ...connection.data,
              status: "reauthorization-required",
              updatedAt: completedAt,
              version: connection.data.version + 1,
            },
          }),
        );
        operations.push(...recordOperations(staleConnection, completedAt, connection));
      }
      await write(invocation, operations, "connection-verification.fail");
      return projection(failed);
    }
  }
  return { requestVerification };
}
