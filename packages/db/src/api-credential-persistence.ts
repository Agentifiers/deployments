import { createHash } from "node:crypto";
import { credentialScopePermits } from "@deployments-ai/identity/scopes";
import { key } from "./keys.ts";
import { PersistenceError } from "./persistence-types.ts";
import type {
  ApiCredential,
  ServiceAccount,
  TenancyContext,
  TenancyPersistence,
} from "./tenancy.ts";
import {
  apiCredentialResult,
  createOperations,
  delegatedScopes,
  id,
  issuedApiCredentialResult,
  mutableRecord,
  updateOperations,
  updatedRecord,
} from "./tenancy.ts";

export function makeApiCredentialPersistence(context: TenancyContext) {
  const {
    generateId,
    now,
    generateSecret,
    getRecord,
    listRecords,
    write,
    environmentPartition,
    credential,
  } = context;
  const service: TenancyPersistence["apiCredentials"] = {
    async list(invocation) {
      const scope = await environmentPartition(invocation);
      const page = await listRecords<ApiCredential>(
        invocation,
        key("ORG", scope.organizationId, "ENV", scope.environmentId),
        "api-credential",
      );
      return {
        items: page.items.map((record) => apiCredentialResult(record.data)),
        nextCursor: page.nextCursor,
      };
    },
    async create(invocation) {
      const scope = await environmentPartition(invocation, true);
      const account = await getRecord<ServiceAccount>(
        {
          pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
          sk: key("SERVICE-ACCOUNT", invocation.body.serviceAccountId),
        },
        "service-account",
        "Service account",
      );
      if (account.data.status !== "active") {
        throw new PersistenceError(
          "conflict",
          "service_account_disabled",
          "The service account is disabled.",
        );
      }
      const scopes = delegatedScopes(
        invocation.identity,
        invocation.body.scopes ?? account.data.scopes,
      );
      if (scopes.some((scopeName) => !credentialScopePermits(account.data.scopes, scopeName))) {
        throw new PersistenceError(
          "unprocessable",
          "invalid_scope",
          "API-key scopes must be a subset of service-account scopes.",
        );
      }
      const timestamp = now().toISOString();
      const resourceId = id(await generateId());
      const secret = generateSecret(resourceId);
      const record = mutableRecord("api-credential", {
        createdAt: timestamp,
        credentialHash: createHash("sha256").update(secret).digest("hex"),
        environmentId: scope.environmentId,
        ...(invocation.body.expiresAt ? { expiresAt: invocation.body.expiresAt } : {}),
        id: resourceId,
        keyPrefix: secret.slice(0, 16),
        name: invocation.body.name,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
        scopes,
        serviceAccountId: account.data.id,
        status: "active",
        updatedAt: timestamp,
        version: 1,
      });
      await write(
        invocation,
        "api-credential.create",
        createOperations(record, timestamp),
        record,
        "api-credential.created",
        timestamp,
        { code: "resource_conflict", message: "The API credential already exists." },
      );
      return issuedApiCredentialResult(record.data, secret);
    },
    async rotate(invocation) {
      const { record: previous, scope } = await credential(invocation, true);
      if (previous.data.status !== "active") {
        throw new PersistenceError(
          "conflict",
          "credential_revoked",
          "Revoked credentials cannot be rotated.",
        );
      }
      const account = await getRecord<ServiceAccount>(
        {
          pk: key("ORG", scope.organizationId, "ENV", scope.environmentId),
          sk: key("SERVICE-ACCOUNT", previous.data.serviceAccountId),
        },
        "service-account",
        "Service account",
      );
      if (account.data.status !== "active") {
        throw new PersistenceError(
          "conflict",
          "service_account_disabled",
          "The service account is disabled.",
        );
      }
      delegatedScopes(invocation.identity, previous.data.scopes);
      const timestamp = now().toISOString();
      const secret = generateSecret(previous.data.id);
      const next = updatedRecord(previous, timestamp, {
        credentialHash: createHash("sha256").update(secret).digest("hex"),
        keyPrefix: secret.slice(0, 16),
      });
      await write(
        invocation,
        "api-credential.rotate",
        updateOperations(previous, next, timestamp),
        next,
        "api-credential.rotated",
        timestamp,
        { code: "resource_conflict", message: "The API credential changed concurrently." },
      );
      return issuedApiCredentialResult(next.data, secret);
    },
    async revoke(invocation) {
      const { record: previous } = await credential(invocation);
      if (previous.data.status === "revoked") return apiCredentialResult(previous.data);
      const timestamp = now().toISOString();
      const next = updatedRecord(previous, timestamp, {
        revokedAt: timestamp,
        status: "revoked",
      });
      await write(
        invocation,
        "api-credential.revoke",
        [{ kind: "put", previousRecord: previous, record: next }],
        next,
        "api-credential.revoked",
        timestamp,
        { code: "version_conflict", message: "The API credential changed concurrently." },
      );
      return apiCredentialResult(next.data);
    },
  };
  return service;
}
