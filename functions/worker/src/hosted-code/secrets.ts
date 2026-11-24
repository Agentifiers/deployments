import {
  CredentialVaultError,
  type CredentialVaultService,
} from "@deployments-ai/credential-vault";
import {
  AuditEventRecord,
  type DynamoDatabaseService,
  type Ulid,
  withCanonicalRecordKeys,
  workerPersistence,
} from "@deployments-ai/db";
import { HOSTED_CODE_SECRETS_VAULT_PURPOSE } from "@deployments-ai/tools";
import { Schema } from "effect";
import type { HostedCodeSecretReadRequest } from "./executor.ts";

/**
 * Reads a hosted code tool's vault entry at the plan-pinned generation and records the
 * secret-free `credential.read` audit event, as for other tool-adapter credentials. A rotated,
 * revoked, or missing entry is a deterministic tool failure, not a retry.
 */
export function createHostedCodeSecretReader(options: {
  readonly credentialVault: Pick<CredentialVaultService, "read">;
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<Ulid>;
}) {
  return async (
    request: HostedCodeSecretReadRequest,
  ): Promise<Readonly<Record<string, string>>> => {
    let values: Readonly<Record<string, string>>;
    try {
      ({ values } = await options.credentialVault.read({
        environmentId: request.environmentId,
        expectedIdentity: {
          ownerId: request.toolAdapterId,
          ownerType: "tool-adapter",
          projectId: request.projectId,
          purpose: HOSTED_CODE_SECRETS_VAULT_PURPOSE,
        },
        organizationId: request.organizationId,
        reference: { ...request.credential, store: "dynamodb-kms" },
      }));
    } catch (cause) {
      if (
        cause instanceof CredentialVaultError &&
        (cause.code === "conflict" || cause.code === "not-found" || cause.code === "revoked")
      ) {
        throw new TypeError("Hosted code secrets changed or were removed.", { cause });
      }
      throw cause;
    }
    const audit = Schema.decodeUnknownSync(AuditEventRecord)(
      withCanonicalRecordKeys({
        data: {
          action: "credential.read",
          actor: { type: "worker" as const },
          environmentId: request.environmentId,
          eventId: await options.generateId(),
          occurredAt: new Date().toISOString(),
          organizationId: request.organizationId,
          projectId: request.projectId,
          resourceId: request.credential.credentialId,
          resourceType: "credential-vault-entry",
        },
        itemType: "audit-event" as const,
      }),
    );
    await workerPersistence.write(
      options.database,
      audit,
      "attribute_not_exists(pk) AND attribute_not_exists(sk)",
    );
    return values;
  };
}
