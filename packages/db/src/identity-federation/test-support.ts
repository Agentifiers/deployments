import { Schema } from "effect";
import {
  DatabaseError,
  type DynamoDatabaseService,
  type TransactionOperation,
} from "../client-types.ts";
import { evaluationMemoryDatabase } from "../evaluations/memory-database.fixture.ts";
import {
  bffFenceRecord,
  principalRecord,
  securityStateRecord,
} from "../identity/record-builders.ts";
import { makeIdGenerator, Ulid } from "../ids.ts";
import {
  tableForItemType,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "../records/index.ts";
import { OrganizationRecord } from "../records/tenancy.ts";
import { LoginDomain, type OidcIdentityProvider } from "../records/identity-federation.ts";
import { organizationMemberRecord } from "../tenancy-record-mapping.ts";
import { makeUniqueClaimRecord, uniqueClaimRequirements } from "../unique-claims.ts";
import { federationRecord } from "./record-builders.ts";
import { makeFederatedSignInStore, type FederatedSignInStore } from "./sign-in.ts";

export const id = Schema.decodeUnknownSync(Ulid);
export const loginDomain = Schema.decodeUnknownSync(LoginDomain);
export const ORGANIZATION = id("01ARZ3NDEKTSV4RRFFQ69G5FC0");
export const OTHER_ORGANIZATION = id("01ARZ3NDEKTSV4RRFFQ69G5FC1");
export const CONNECTION = id("01ARZ3NDEKTSV4RRFFQ69G5FC2");
export const DOMAIN_ID = id("01ARZ3NDEKTSV4RRFFQ69G5FC3");
export const EXISTING_PRINCIPAL = id("01ARZ3NDEKTSV4RRFFQ69G5FC4");
export const ISSUER = "https://acme.okta.com";
export const START = "2026-10-08T12:00:00.000Z";
export const ENDPOINTS_WITHOUT_USERINFO = {
  authorization: `${ISSUER}/oauth2/v1/authorize`,
  jwks: `${ISSUER}/oauth2/v1/keys`,
  token: `${ISSUER}/oauth2/v1/token`,
} as const;

const ENVELOPE = {
  algorithm: "AES-256-GCM",
  authenticationTag: "tag",
  ciphertext: "ciphertext",
  encryptedDataKey: "key",
  encryptionContextHash: "hash",
  iv: "iv",
  schemaVersion: 1,
} as const;

function conflict(message: string) {
  return new DatabaseError({
    cause: "ConditionalCheckFailedException",
    message,
    operation: "transact-write",
    reason: "conflict",
    table: "multiple",
  });
}

const storeKey = (table: string, pk: string, sk: string) => `${table}\u0000${pk}\u0000${sk}`;

/** DynamoDB lets an expiring claim replace a stored one whose `expiresAt` <= the observed now. */
function lapsedClaim(
  records: ReadonlyMap<string, PlatformRecord>,
  operation: TransactionOperation,
): (readonly [string, PlatformRecord])[] {
  if (operation.kind !== "put" || !operation.replaceExpired) return [];
  const itemKey = storeKey(
    tableForItemType(operation.record.itemType),
    operation.record.pk,
    operation.record.sk,
  );
  const stored = records.get(itemKey);
  const observedAt = operation.expressionAttributeValues?.[":uniqueClaimNow"];
  return stored?.itemType === "unique-claim" &&
    stored.data.expiresAt !== undefined &&
    typeof observedAt === "string" &&
    stored.data.expiresAt <= observedAt
    ? [[itemKey, stored]]
    : [];
}

export type RecordOf<ItemType extends PlatformRecord["itemType"]> = Extract<
  PlatformRecord,
  { readonly itemType: ItemType }
>;

export interface FederationMemoryDatabase {
  readonly beforeCommit: (change: (records: Map<string, PlatformRecord>) => void) => void;
  readonly database: DynamoDatabaseService;
  readonly of: <ItemType extends PlatformRecord["itemType"]>(
    itemType: ItemType,
  ) => RecordOf<ItemType>[];
  readonly put: (record: PlatformRecord) => void;
  readonly remove: (record: PlatformRecord) => void;
}

export function federationMemoryDatabase(
  initial: readonly PlatformRecord[] = [],
): FederationMemoryDatabase {
  const inner = evaluationMemoryDatabase(
    initial.flatMap((record) => [
      record,
      ...uniqueClaimRequirements(record).map(
        (requirement) => makeUniqueClaimRecord(requirement, START) as PlatformRecord,
      ),
    ]),
  );
  const pending: ((records: Map<string, PlatformRecord>) => void)[] = [];
  const database: DynamoDatabaseService = {
    ...inner.database,
    transactWrite: async (operations: readonly TransactionOperation[], token, signal) => {
      pending.shift()?.(inner.records);
      for (const operation of operations) {
        if (operation.kind !== "condition-check") continue;
        if (operation.conditionExpression !== "#data.#version = :version") continue;
        const stored = inner.records.get(
          storeKey(operation.table, operation.key.pk, operation.key.sk),
        );
        const version = stored && "version" in stored.data ? stored.data.version : undefined;
        if (version !== operation.expressionAttributeValues?.[":version"]) {
          throw conflict("A pinned record changed.");
        }
      }
      const lapsed = operations.flatMap((operation) => lapsedClaim(inner.records, operation));
      for (const [itemKey] of lapsed) inner.records.delete(itemKey);
      try {
        return await inner.database.transactWrite(operations, token, signal);
      } catch (error) {
        for (const [itemKey, claim] of lapsed) inner.records.set(itemKey, claim);
        throw error;
      }
    },
  };
  return {
    beforeCommit: (change) => {
      pending.push(change);
    },
    database,
    of: <ItemType extends PlatformRecord["itemType"]>(itemType: ItemType) =>
      inner.all().filter((record): record is RecordOf<ItemType> => record.itemType === itemType),
    put: (record: PlatformRecord) => {
      inner.records.set(storeKey(tableForItemType(record.itemType), record.pk, record.sk), record);
    },
    remove: (record: PlatformRecord) => {
      inner.records.delete(storeKey(tableForItemType(record.itemType), record.pk, record.sk));
    },
  };
}

export function providerRecord(overrides: Partial<OidcIdentityProvider> = {}) {
  return federationRecord("organization-identity-provider", {
    clientId: "0oa-client",
    clientSecret: ENVELOPE,
    clientSecretSetAt: START,
    connectionId: CONNECTION,
    createdAt: START,
    displayName: "Acme Okta",
    endpoints: { ...ENDPOINTS_WITHOUT_USERINFO, userinfo: `${ISSUER}/oauth2/v1/userinfo` },
    id: "oidc",
    issuer: ISSUER,
    jit: { kind: "enabled", role: "member" },
    organizationId: ORGANIZATION,
    signingAlgorithms: ["RS256"],
    state: { enforcement: "optional", kind: "active" },
    tokenEndpointAuthMethod: "client_secret_basic",
    updatedAt: START,
    version: 1,
    ...overrides,
  });
}

export function organizationRecord(name = "Acme") {
  return Schema.decodeUnknownSync(OrganizationRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: START,
        id: ORGANIZATION,
        name,
        slug: "acme",
        status: "active",
        updatedAt: START,
        version: 1,
      },
      itemType: "organization",
    }),
  );
}

export function verifiedDomainRecord(domain = "acme.com", organizationId = ORGANIZATION) {
  return federationRecord("organization-login-domain", {
    createdAt: START,
    domain: loginDomain(domain),
    id: DOMAIN_ID,
    organizationId,
    state: { kind: "verified", verifiedAt: START },
    updatedAt: START,
    verificationToken: "token",
    version: 1,
  });
}

export function existingPrincipal(email: string, principalId = EXISTING_PRINCIPAL) {
  return [
    principalRecord({ createdAt: START, id: principalId, primaryEmail: email }),
    securityStateRecord({
      createdAt: START,
      credentialVersion: 1,
      emailVerifiedAt: START,
      principalId,
      sessionEpoch: 3,
      version: 1,
    }),
    bffFenceRecord({
      createdAt: START,
      principalId,
      principalStatus: "active",
      sessionEpoch: 3,
      version: 1,
    }),
  ];
}

export function memberRecord(
  principalId: Ulid,
  status: "active" | "invited" | "removed",
  role: "admin" | "member" | "owner" | "viewer" = "admin",
) {
  return organizationMemberRecord({
    createdAt: START,
    organizationId: ORGANIZATION,
    principalId,
    role,
    status,
    updatedAt: START,
    version: 1,
  });
}

export interface SignInStoreFixture {
  readonly sentEmails: unknown[];
  readonly store: FederatedSignInStore;
}

/** A sign-in store over any database; tokens count up from `token-1`. */
export function federatedSignInStore(
  database: DynamoDatabaseService,
  now: () => Date,
): SignInStoreFixture {
  let tokens = 0;
  const sentEmails: unknown[] = [];
  const store = makeFederatedSignInStore(
    {
      database,
      encryptEmailPayload: async (value) => {
        sentEmails.push(value);
        return ENVELOPE;
      },
      generateId: makeIdGenerator().generate,
      newToken: () => `token-${(tokens += 1)}`,
      now,
    },
    {
      linkRequestLifetimeSeconds: 1_800,
      sessionAbsoluteLifetimeSeconds: 86_400,
      sessionIdleLifetimeSeconds: 3_600,
      transactionLifetimeSeconds: 600,
    },
  );
  return { sentEmails, store };
}

export interface SignInHarness extends SignInStoreFixture {
  readonly advance: (milliseconds: number) => void;
  readonly memory: FederationMemoryDatabase;
}

export function signInHarness(initial: readonly PlatformRecord[]): SignInHarness {
  let clock = Date.parse(START);
  const memory = federationMemoryDatabase(initial);
  return {
    ...federatedSignInStore(memory.database, () => new Date(clock)),
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    memory,
  };
}
