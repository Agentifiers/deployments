import type { CredentialVaultService } from "@deployments-ai/credential-vault";
import {
  AuditEventRecord,
  type DynamoDatabaseService,
  type Ulid,
  withCanonicalRecordKeys,
  workerPersistence,
} from "@deployments-ai/db";
import { Schema } from "effect";
import type { createDynamoExtensionToolResolver } from "./dynamodb-extension-tools.ts";
import type { ReadRuntimeMcpCredential } from "./dynamodb-runtime-mcp.ts";
import type { ReadRuntimeCredential } from "./runtime-provider-binding.ts";
import type { AgentRunWorkerDependencies } from "./types.ts";

type ReadToolAdapterCredential = NonNullable<
  Parameters<typeof createDynamoExtensionToolResolver>[1]
>["readCredential"];
type ReadChannelCredential = NonNullable<AgentRunWorkerDependencies["readChannelCredential"]>;

export function createWorkerCredentialReaders({
  credentialVault,
  database,
  generateId,
}: {
  readonly credentialVault: Pick<CredentialVaultService, "read">;
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<Ulid>;
}) {
  const readProviderConnectionCredential: ReadRuntimeCredential = async ({
    connectionId,
    environmentId,
    organizationId,
    projectId,
    purpose,
    reference,
  }) => {
    const secret = await credentialVault.read({
      environmentId,
      expectedIdentity: {
        ownerId: connectionId,
        ownerType: "provider-connection",
        projectId,
        purpose,
      },
      organizationId,
      reference,
    });
    const occurredAt = new Date().toISOString();
    const audit = Schema.decodeUnknownSync(AuditEventRecord)(
      withCanonicalRecordKeys({
        data: {
          action: "credential.read",
          actor: { type: "worker" as const },
          environmentId,
          eventId: await generateId(),
          occurredAt,
          organizationId,
          projectId,
          resourceId: reference.credentialId,
          resourceType: "credential-vault-entry",
        },
        itemType: "audit-event" as const,
      }),
    );
    await workerPersistence.write(
      database,
      audit,
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    );
    return secret;
  };
  const readMcpServerCredential: ReadRuntimeMcpCredential = async ({
    environmentId,
    organizationId,
    projectId,
    reference,
    serverId,
  }) => {
    const secret = await credentialVault.read({
      environmentId,
      expectedIdentity: {
        ownerId: serverId,
        ownerType: "mcp-server",
        projectId,
        purpose: "mcp-server-auth",
      },
      organizationId,
      reference,
    });
    const occurredAt = new Date().toISOString();
    const audit = Schema.decodeUnknownSync(AuditEventRecord)(
      withCanonicalRecordKeys({
        data: {
          action: "credential.read",
          actor: { type: "worker" as const },
          environmentId,
          eventId: await generateId(),
          occurredAt,
          organizationId,
          projectId,
          resourceId: reference.credentialId,
          resourceType: "credential-vault-entry",
        },
        itemType: "audit-event" as const,
      }),
    );
    await workerPersistence.write(
      database,
      audit,
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    );
    return secret;
  };
  const readToolAdapterCredential: ReadToolAdapterCredential = async ({
    environmentId,
    organizationId,
    projectId,
    reference,
    toolAdapterId,
  }) => {
    const secret = await credentialVault.read({
      environmentId,
      expectedIdentity: {
        ownerId: toolAdapterId,
        ownerType: "tool-adapter",
        projectId,
        purpose: "extension-callback-auth",
      },
      organizationId,
      reference,
    });
    const occurredAt = new Date().toISOString();
    const audit = Schema.decodeUnknownSync(AuditEventRecord)(
      withCanonicalRecordKeys({
        data: {
          action: "credential.read",
          actor: { type: "worker" as const },
          environmentId,
          eventId: await generateId(),
          occurredAt,
          organizationId,
          projectId,
          resourceId: reference.credentialId,
          resourceType: "credential-vault-entry",
        },
        itemType: "audit-event" as const,
      }),
    );
    await workerPersistence.write(
      database,
      audit,
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    );
    return secret;
  };
  const readChannelCredential: ReadChannelCredential = async ({
    bindingId,
    environmentId,
    organizationId,
    projectId,
    reference,
  }) => {
    const secret = await credentialVault.read({
      environmentId,
      expectedIdentity: {
        ownerId: bindingId,
        ownerType: "channel-binding",
        projectId,
        purpose: "channel-runtime",
      },
      organizationId,
      reference,
    });
    const occurredAt = new Date().toISOString();
    const audit = Schema.decodeUnknownSync(AuditEventRecord)(
      withCanonicalRecordKeys({
        data: {
          action: "credential.read",
          actor: { type: "worker" as const },
          environmentId,
          eventId: await generateId(),
          occurredAt,
          organizationId,
          projectId,
          resourceId: reference.credentialId,
          resourceType: "credential-vault-entry",
        },
        itemType: "audit-event" as const,
      }),
    );
    await workerPersistence.write(
      database,
      audit,
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    );
    return secret.values;
  };
  return {
    readChannelCredential,
    readMcpServerCredential,
    readProviderConnectionCredential,
    readToolAdapterCredential,
  };
}
