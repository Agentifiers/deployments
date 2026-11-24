import type { Ulid } from "../ids.ts";
import type { PlatformRecord } from "../records/index.ts";

/**
 * Durable credential-vault owner types in inventory order. Ephemeral owners
 * (`oauth-authorization-attempt`, `stream-session`) expire with their TTL and are never listed.
 */
export const CREDENTIAL_REFERENCE_OWNER_TYPES = [
  "channel-binding",
  "mcp-server",
  "provider-application",
  "provider-connection",
  "tool-adapter",
  "webhook-endpoint",
] as const;

export type CredentialReferenceOwnerType = (typeof CREDENTIAL_REFERENCE_OWNER_TYPES)[number];

export type CredentialReferenceOwner = Extract<
  PlatformRecord,
  { readonly itemType: CredentialReferenceOwnerType }
>;

/**
 * Metadata-only projection of one owner-held vault reference. It never carries a secret value,
 * ciphertext, data key, or hash; timestamps are the owner record's.
 */
export interface CredentialReferenceSummary {
  readonly createdAt: string;
  readonly credentialId: Ulid;
  readonly expiresAt?: string;
  readonly generation: number;
  readonly ownerId: Ulid;
  readonly ownerName?: string;
  readonly ownerStatus: string;
  readonly ownerType: CredentialReferenceOwnerType;
  readonly providerKey?: string;
  readonly purpose: string;
  readonly secretNames?: readonly string[];
  /** Vault entry state implied by the owner lifecycle: terminal owner transitions revoke it. */
  readonly status: "active" | "revoked";
  readonly store: "dynamodb-kms";
  readonly updatedAt: string;
}

/** Owner statuses whose transition revokes the owner's vault entry in the same transaction. */
const REVOKING_OWNER_STATUS: Readonly<Record<CredentialReferenceOwnerType, string | undefined>> = {
  // Archiving a channel binding keeps its credential; only credential revoke removes it.
  "channel-binding": undefined,
  "mcp-server": "archived",
  "provider-application": "archived",
  "provider-connection": "disconnected",
  "tool-adapter": "archived",
  "webhook-endpoint": "archived",
};

const HOSTED_CODE_SECRETS_PURPOSE = "hosted-code-secrets";

function ownerDetails(record: CredentialReferenceOwner) {
  switch (record.itemType) {
    case "channel-binding":
      return {
        providerKey: record.data.provider,
        purpose: "channel-runtime",
        reference: record.data.credentialRef,
      };
    case "mcp-server":
      return {
        ownerName: record.data.name,
        purpose: "mcp-server-auth",
        reference: record.data.authSecretRef,
      };
    case "provider-application":
      return {
        ownerName: record.data.displayName,
        providerKey: record.data.providerKey,
        purpose: "provider-oauth-client-secret",
        reference: record.data.clientSecretRef,
      };
    case "provider-connection": {
      const displayName = record.data.displayMetadata?.displayName;
      const method = record.data.authMethod.trim().toLowerCase();
      const purpose =
        method === "oauth" || method === "oauth2" ? "provider-oauth-token" : "provider-api";
      return {
        // OAuth connections record the access-token expiry as their refresh deadline.
        ...(purpose === "provider-oauth-token" && record.data.refreshAfter
          ? { expiresAt: record.data.refreshAfter }
          : {}),
        ownerName: typeof displayName === "string" ? displayName : record.data.providerKey,
        providerKey: record.data.providerKey,
        purpose,
        reference: record.data.credentialRef,
      };
    }
    case "tool-adapter": {
      const { execution } = record.data;
      const hostedCode = execution.type === "hosted_code";
      const secretNames = hostedCode ? execution.secretNames : undefined;
      return {
        ownerName: record.data.name,
        ...(record.data.providerKey ? { providerKey: record.data.providerKey } : {}),
        purpose: hostedCode ? HOSTED_CODE_SECRETS_PURPOSE : "extension-callback-auth",
        reference: record.data.authSecretRef,
        ...(secretNames ? { secretNames } : {}),
      };
    }
    case "webhook-endpoint":
      return {
        ownerName: record.data.name,
        purpose: "webhook-signing",
        reference: record.data.signingSecretRef,
      };
  }
}

/** Projects an owner record to its vault reference metadata, or nothing when it holds none. */
export function credentialReferenceSummary(
  record: CredentialReferenceOwner,
): CredentialReferenceSummary | undefined {
  const { reference, ...details } = ownerDetails(record);
  // Only credential-vault references are inventoried; the vault is the tenant secret store.
  if (!reference || !("store" in reference)) return undefined;
  const revoked = REVOKING_OWNER_STATUS[record.itemType] === record.data.status;
  return {
    ...details,
    createdAt: record.data.createdAt,
    credentialId: reference.credentialId,
    generation: reference.generation,
    ownerId: record.data.id,
    ownerStatus: record.data.status,
    ownerType: record.itemType,
    status: revoked ? "revoked" : "active",
    store: reference.store,
    updatedAt: record.data.updatedAt,
  };
}
