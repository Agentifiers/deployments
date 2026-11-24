import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { EnvelopeAdapter } from "../identity/kms-envelope.ts";
import { makeIdGenerator, type Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { PersistenceError } from "../persistence-types.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { ModelProviderCredentialRecord, type ByokProvider } from "../records/model-credentials.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";

export const MODEL_PROVIDER_CREDENTIAL_PURPOSE = "model-provider-credential";

type CredentialData = ModelProviderCredentialRecord["data"];

/**
 * The KMS encryption context and GCM associated data that bind a sealed key to exactly one
 * organization, provider, credential, and key version. It carries no project or environment.
 */
export function modelProviderCredentialBinding(
  data: Pick<CredentialData, "credentialId" | "id" | "keyVersion" | "organizationId">,
) {
  return {
    credentialId: data.credentialId,
    keyVersion: String(data.keyVersion),
    organizationId: data.organizationId,
    provider: data.id,
    purpose: MODEL_PROVIDER_CREDENTIAL_PURPOSE,
  };
}

/** Everything about a stored credential except its ciphertext. */
export interface ModelProviderCredentialSummary {
  readonly createdAt: string;
  readonly credentialId: Ulid;
  readonly keyVersion: number;
  readonly label?: string;
  readonly lastFour: string;
  readonly provider: ByokProvider;
  readonly revokedAt?: string;
  readonly revokedBy?: Ulid;
  readonly setAt: string;
  readonly setBy: Ulid;
  readonly status: "active" | "revoked";
  readonly updatedAt: string;
  readonly version: number;
}

function summary({ data }: ModelProviderCredentialRecord): ModelProviderCredentialSummary {
  return {
    createdAt: data.createdAt,
    credentialId: data.credentialId,
    keyVersion: data.keyVersion,
    ...(data.label === undefined ? {} : { label: data.label }),
    lastFour: data.lastFour,
    provider: data.id,
    ...(data.state.kind === "revoked"
      ? { revokedAt: data.state.revokedAt, revokedBy: data.state.revokedBy }
      : {}),
    setAt: data.setAt,
    setBy: data.setBy,
    status: data.state.kind,
    updatedAt: data.updatedAt,
    version: data.version,
  };
}

export interface ModelProviderCredentialChange {
  readonly actorPrincipalId: Ulid;
  readonly organizationId: Ulid;
  readonly provider: ByokProvider;
}

export interface ModelProviderCredentialPersistence {
  readonly get: (
    organizationId: Ulid,
    provider: ByokProvider,
  ) => Promise<ModelProviderCredentialSummary | undefined>;
  readonly list: (organizationId: Ulid) => Promise<readonly ModelProviderCredentialSummary[]>;
  /** Revokes the active key and discards its ciphertext; a revoked credential is returned as is. */
  readonly remove: (
    input: ModelProviderCredentialChange,
  ) => Promise<ModelProviderCredentialSummary | undefined>;
  /**
   * Stores a key the caller has already verified with the provider. The credential ID is fixed
   * when the organization first sets a key for the provider; every set, including one after
   * removal, advances the key version, so a gateway that pinned an earlier version stops using it.
   */
  readonly set: (
    input: ModelProviderCredentialChange & { readonly apiKey: string; readonly label?: string },
  ) => Promise<ModelProviderCredentialSummary>;
}

const CREDENTIAL_PREFIX = "MODEL-PROVIDER-CREDENTIAL";

/** An organization's stored credentials, one per provider, without their ciphertext. */
export async function listModelProviderCredentials(
  database: DynamoDatabaseService,
  organizationId: Ulid,
): Promise<readonly ModelProviderCredentialSummary[]> {
  const result = await database.queryRecords("control", {
    ConsistentRead: true,
    ExpressionAttributeValues: {
      ":pk": key("ORG", organizationId),
      ":sk": `${CREDENTIAL_PREFIX}#`,
    },
    KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
  });
  return result.items
    .filter(
      (record): record is ModelProviderCredentialRecord =>
        record.itemType === "model-provider-credential",
    )
    .map(summary);
}

/** The stored credential record for one organization and provider, read strongly consistent. */
export async function readModelProviderCredentialRecord(
  database: DynamoDatabaseService,
  organizationId: Ulid,
  provider: ByokProvider,
): Promise<ModelProviderCredentialRecord | undefined> {
  const stored = await database.getRecord(
    "control",
    { pk: key("ORG", organizationId), sk: key(CREDENTIAL_PREFIX, provider) },
    true,
  );
  return stored?.itemType === "model-provider-credential" ? stored : undefined;
}

export function makeModelProviderCredentialPersistence(dependencies: {
  readonly database: DynamoDatabaseService;
  readonly envelope: Pick<EnvelopeAdapter, "encrypt">;
  readonly generateId?: () => Ulid;
  readonly now?: () => Date;
}): ModelProviderCredentialPersistence {
  const { database, envelope } = dependencies;
  const ids = makeIdGenerator();
  const generateId = dependencies.generateId ?? (() => ids.generate());
  const now = dependencies.now ?? (() => new Date());

  const organizationNotFound = async (organizationId: Ulid) => {
    const organization = await database.getRecord(
      "control",
      { pk: key("ORG", organizationId), sk: key("ORG", organizationId) },
      true,
    );
    return organization?.itemType === "organization"
      ? undefined
      : new PersistenceError(
          "not-found",
          "organization_not_found",
          `Organization ${organizationId} does not exist.`,
        );
  };

  const write = async (
    input: ModelProviderCredentialChange,
    previous: ModelProviderCredentialRecord | undefined,
    record: ModelProviderCredentialRecord,
    eventType: "organization.model-credential-removed" | "organization.model-credential-set",
  ) => {
    const { data } = record;
    const event = makeSemanticEventRecord({
      actor: { id: input.actorPrincipalId, type: "principal" },
      aggregateId: data.credentialId,
      aggregateType: "model-provider-credential",
      aggregateVersion: data.version,
      eventId: generateId(),
      eventType,
      occurredAt: data.updatedAt,
      organizationId: data.organizationId,
      payload: {
        credentialId: data.credentialId,
        keyVersion: data.keyVersion,
        provider: data.id,
      },
    });
    try {
      await transactWithSemanticEvents(
        database,
        [{ kind: "put", ...(previous ? { previousRecord: previous } : {}), record }],
        [event],
      );
    } catch (cause) {
      if (isDatabaseWriteConflict(cause)) {
        throw (
          (await organizationNotFound(input.organizationId)) ??
          new PersistenceError(
            "conflict",
            "model_credential_conflict",
            "The model provider credential changed concurrently; retry the request.",
          )
        );
      }
      throw cause;
    }
    return summary(record);
  };

  return {
    get: async (organizationId, provider) => {
      const record = await readModelProviderCredentialRecord(database, organizationId, provider);
      return record && summary(record);
    },

    list: (organizationId) => listModelProviderCredentials(database, organizationId),

    remove: async (input) => {
      const previous = await readModelProviderCredentialRecord(
        database,
        input.organizationId,
        input.provider,
      );
      if (!previous || previous.data.state.kind === "revoked") return previous && summary(previous);
      const at = now().toISOString();
      const record = Schema.decodeUnknownSync(ModelProviderCredentialRecord)(
        withCanonicalRecordKeys({
          data: {
            ...previous.data,
            state: { kind: "revoked", revokedAt: at, revokedBy: input.actorPrincipalId },
            updatedAt: at,
            version: previous.data.version + 1,
          },
          itemType: "model-provider-credential",
        }),
      );
      return write(input, previous, record, "organization.model-credential-removed");
    },

    set: async (input) => {
      const previous = await readModelProviderCredentialRecord(
        database,
        input.organizationId,
        input.provider,
      );
      const at = now().toISOString();
      const identity = {
        credentialId: previous?.data.credentialId ?? generateId(),
        id: input.provider,
        keyVersion: (previous?.data.keyVersion ?? 0) + 1,
        organizationId: input.organizationId,
      };
      const sealed = await envelope.encrypt(input.apiKey, modelProviderCredentialBinding(identity));
      const record = Schema.decodeUnknownSync(ModelProviderCredentialRecord)(
        withCanonicalRecordKeys({
          data: {
            ...identity,
            createdAt: previous?.data.createdAt ?? at,
            ...(input.label === undefined ? {} : { label: input.label }),
            lastFour: input.apiKey.slice(-4),
            setAt: at,
            setBy: input.actorPrincipalId,
            state: { envelope: sealed, kind: "active" },
            updatedAt: at,
            version: (previous?.data.version ?? 0) + 1,
          },
          itemType: "model-provider-credential",
        }),
      );
      return write(input, previous, record, "organization.model-credential-set");
    },
  };
}
