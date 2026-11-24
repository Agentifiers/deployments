import {
  DeleteChannelBindingCredentialRequest,
  PutChannelBindingCredentialRequest,
} from "@deployments-ai/api-contract/runtime";
import {
  assertNoReservedProviderOAuthMaterialFields,
  CredentialVaultError,
  normalizeCredentialVaultSecret,
  type CredentialVaultPreparedMutation,
  type CredentialVaultSecretInput,
} from "@deployments-ai/credential-vault";
import {
  AuditEventRecord,
  ChannelBindingRecord,
  isDatabaseWriteConflict,
  withCanonicalRecordKeys,
  type Ulid,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { replaceBinding } from "./channel-bindings.ts";
import { loadChannelBinding, omitUndefined, type Binding } from "./channel-validation.ts";
import { numberValue } from "./request-validation.ts";
import { recordActor } from "./runtime-principal.ts";
import {
  RuntimeApiError,
  requireScope,
  type RuntimeApiDependencies,
  type RuntimeApiPrincipal,
} from "./runtime-support.ts";

function credentialRequest(
  method: "PUT" | "DELETE",
  input: Readonly<Record<string, unknown>>,
  now: Date,
): { readonly expectedVersion: number; readonly secret?: CredentialVaultSecretInput } {
  const expectedVersion = numberValue(input, "expectedVersion");
  if (expectedVersion === undefined || expectedVersion < 0) {
    throw new RuntimeApiError(
      400,
      "invalid_expected_version",
      "expectedVersion must be a non-negative integer.",
    );
  }
  try {
    const options = { onExcessProperty: "error" } as const;
    if (method === "DELETE") {
      Schema.decodeUnknownSync(DeleteChannelBindingCredentialRequest, options)(input);
      return { expectedVersion };
    }
    const request = Schema.decodeUnknownSync(PutChannelBindingCredentialRequest, options)(input);
    const secret = normalizeCredentialVaultSecret({
      values: request.values,
      ...(request.scopes === undefined ? {} : { scopes: request.scopes }),
      ...(request.expiresAt === undefined ? {} : { expiresAt: request.expiresAt }),
    });
    assertNoReservedProviderOAuthMaterialFields(secret.values);
    if (secret.expiresAt && Date.parse(secret.expiresAt) <= now.getTime()) {
      throw new Error("Credential expiration must be in the future.");
    }
    return { expectedVersion, secret };
  } catch {
    // Schema diagnostics can contain input values; never return credential material.
    throw new RuntimeApiError(400, "invalid_credential_request", "Credential request is invalid.");
  }
}

function assertCredentialOwner(prepared: CredentialVaultPreparedMutation, binding: Binding) {
  const entry = prepared.operation.record;
  if (
    entry.itemType !== "credential-vault-entry" ||
    entry.data.organizationId !== binding.data.organizationId ||
    entry.data.projectId !== binding.data.projectId ||
    entry.data.environmentId !== binding.data.environmentId ||
    entry.data.ownerId !== binding.data.id ||
    entry.data.ownerType !== "channel-binding" ||
    entry.data.purpose !== "channel-runtime"
  ) {
    throw new RuntimeApiError(
      409,
      "binding_credential_invalid",
      "The attached credential does not belong to this channel binding.",
    );
  }
}

export async function mutateChannelBindingCredential(
  principal: RuntimeApiPrincipal,
  bindingId: Ulid,
  method: "PUT" | "DELETE",
  input: Readonly<Record<string, unknown>>,
  dependencies: RuntimeApiDependencies,
): Promise<Binding> {
  requireScope(principal, "channels:write");
  const now = dependencies.now?.() ?? new Date();
  const request = credentialRequest(method, input, now);
  const previous = await loadChannelBinding(principal, bindingId, dependencies);
  if (previous.data.version !== request.expectedVersion) {
    throw new RuntimeApiError(
      409,
      "binding_version_conflict",
      "Channel binding version does not match expectedVersion.",
    );
  }
  if (method === "PUT" && previous.data.status === "archived") {
    throw new RuntimeApiError(409, "binding_archived", "Archived channel bindings cannot change.");
  }
  const reference = previous.data.credentialRef;
  if (method === "DELETE" && !reference) return previous;
  if (reference && (!("store" in reference) || reference.store !== "dynamodb-kms")) {
    throw new RuntimeApiError(
      409,
      "binding_credential_invalid",
      "The attached channel credential is not managed by the credential vault.",
    );
  }
  const vault = dependencies.credentialVault;
  if (!vault) {
    throw new RuntimeApiError(
      503,
      "credential_vault_unavailable",
      "Credential vault is unavailable.",
    );
  }
  try {
    const prepared = request.secret
      ? await vault.prepareWrite({
          identity: {
            ...principal.scope,
            credentialId: reference?.credentialId ?? (await dependencies.generateId()),
            ownerId: bindingId,
            ownerType: "channel-binding",
            purpose: "channel-runtime",
          },
          ...(reference ? { expectedGeneration: reference.generation } : {}),
          secret: request.secret,
        })
      : await vault.prepareRevoke({
          organizationId: principal.scope.organizationId,
          environmentId: principal.scope.environmentId,
          reference: reference!,
        });
    assertCredentialOwner(prepared, previous);
    const next = Schema.decodeUnknownSync(ChannelBindingRecord)(
      withCanonicalRecordKeys({
        data: omitUndefined({
          ...previous.data,
          credentialRef: method === "PUT" ? prepared.reference : undefined,
          lastVerifiedAt: undefined,
          status: previous.data.status === "archived" ? "archived" : "disabled",
          updatedAt: now.toISOString(),
          version: previous.data.version + 1,
        }),
        itemType: "channel-binding" as const,
      }),
    );
    const audit = Schema.decodeUnknownSync(AuditEventRecord)(
      withCanonicalRecordKeys({
        data: {
          ...principal.scope,
          action:
            method === "DELETE"
              ? "credential.revoke"
              : reference
                ? "credential.rotate"
                : "credential.create",
          actor: recordActor(principal),
          eventId: await dependencies.generateId(),
          occurredAt: now.toISOString(),
          resourceId: prepared.reference.credentialId,
          resourceType: "credential-vault-entry",
        },
        itemType: "audit-event" as const,
      }),
    );
    return await replaceBinding(previous, next, "channel.binding.updated", dependencies, [
      prepared.operation,
      { kind: "put", record: audit },
    ]);
  } catch (cause) {
    if (
      isDatabaseWriteConflict(cause) ||
      (cause instanceof CredentialVaultError &&
        ["conflict", "not-found", "revoked"].includes(cause.code))
    ) {
      throw new RuntimeApiError(
        409,
        "binding_credential_conflict",
        "The channel binding or its credential changed; reload the binding before retrying.",
      );
    }
    throw cause;
  }
}
