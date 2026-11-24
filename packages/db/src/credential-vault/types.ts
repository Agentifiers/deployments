import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { KMSClient } from "@aws-sdk/client-kms";
import type { TransactionPut } from "../client-types.ts";
import type { Ulid } from "../ids.ts";

export const CREDENTIAL_VAULT_STORE = "dynamodb-kms" as const;
export const CREDENTIAL_VAULT_SCHEMA_VERSION = 1 as const;
export const CREDENTIAL_VAULT_ALGORITHM = "AES-256-GCM" as const;

export type CredentialVaultOwnerType =
  | "channel-binding"
  | "mcp-server"
  | "oauth-authorization-attempt"
  | "provider-application"
  | "provider-connection"
  | "stream-session"
  | "tool-adapter"
  | "webhook-endpoint";

export interface CredentialVaultIdentity {
  readonly credentialId: Ulid;
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly ownerId: Ulid;
  readonly ownerType: CredentialVaultOwnerType;
  readonly projectId: Ulid;
  readonly purpose: string;
}

export interface CredentialVaultSecretInput {
  readonly expiresAt?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly scopes?: readonly string[];
  readonly values: Readonly<Record<string, string>>;
}

export interface CredentialVaultSecretDocument extends CredentialVaultSecretInput {
  readonly createdAt: string;
  readonly generation: number;
  readonly schemaVersion: typeof CREDENTIAL_VAULT_SCHEMA_VERSION;
  readonly updatedAt: string;
}

export interface CredentialVaultReference {
  readonly credentialId: Ulid;
  readonly generation: number;
  readonly store: typeof CREDENTIAL_VAULT_STORE;
}

export interface CredentialVaultConfig {
  readonly dataKeyCacheMaxEntries?: number;
  readonly dataKeyCacheTtlMs?: number;
  readonly documentClient: DynamoDBDocumentClient;
  readonly kmsClient: KMSClient;
  readonly kmsKeyArn: string;
  readonly tableName: string;
}

export interface CredentialVaultWriteRequest {
  readonly expectedGeneration?: number;
  readonly identity: CredentialVaultIdentity;
  readonly secret: CredentialVaultSecretInput;
}

export interface CredentialVaultReferenceRequest {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly reference: CredentialVaultReference;
}

export interface CredentialVaultReadRequest extends CredentialVaultReferenceRequest {
  readonly expectedIdentity: Pick<
    CredentialVaultIdentity,
    "ownerId" | "ownerType" | "projectId" | "purpose"
  >;
}

export interface CredentialVaultService {
  readonly prepareRevoke: (
    request: CredentialVaultReferenceRequest,
  ) => Promise<CredentialVaultPreparedMutation>;
  readonly prepareWrite: (
    request: CredentialVaultWriteRequest,
  ) => Promise<CredentialVaultPreparedMutation>;
  readonly read: (request: CredentialVaultReadRequest) => Promise<CredentialVaultSecretDocument>;
  readonly revoke: (request: CredentialVaultReferenceRequest) => Promise<void>;
  readonly write: (request: CredentialVaultWriteRequest) => Promise<CredentialVaultReference>;
}

export interface CredentialVaultPreparedMutation {
  readonly operation: TransactionPut;
  readonly reference: CredentialVaultReference;
}

export class CredentialVaultError extends Error {
  readonly code: "conflict" | "crypto" | "invalid-input" | "not-found" | "revoked" | "storage";

  constructor(code: CredentialVaultError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialVaultError";
    this.code = code;
  }
}
