import {
  bffFenceRecord,
  makeAccountStandingRepository,
  makeDynamoDatabase,
  makeIdentityRepository,
  passwordCredentialRecord,
  principalRecord,
  securityStateRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type ProtectedEnvelope,
  type TransactionOperation,
  type Ulid,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import {
  DEFAULT_PASSWORD_PROFILE,
  base32Decode,
  emailClaimValue,
  hashPassword,
  hotp,
  totpStep,
} from "@deployments-ai/identity";
import { createWithClaims } from "../../../packages/db/src/identity-federation/operations.ts";
import {
  ORGANIZATION,
  memberRecord,
  organizationRecord,
} from "../../../packages/db/src/identity-federation/test-support.ts";
import { makeIdentityApplication } from "./application.ts";
import { DEFAULT_IDENTITY_RATE_LIMIT_POLICIES } from "./rate-limits.ts";
import { sequentialIds } from "./session-management.fixture.ts";

export const ADA = "01ARZ3NDEKTSV4RRFFQ69G5FD0" as Ulid;
export const GRACE = "01ARZ3NDEKTSV4RRFFQ69G5FD1" as Ulid;
export const ADA_EMAIL = "ada@example.com";
export const GRACE_EMAIL = "grace@example.com";
export const PASSWORD = "correct horse battery staple";
export { ORGANIZATION };
const CREATED_AT = "2026-07-28T00:00:00.000Z";

/** Seals values as readable JSON bound to their context, so tests can read what a delivery carries. */
export const plainSecrets = {
  decrypt: async <Value>(
    envelope: ProtectedEnvelope,
    binding: Readonly<Record<string, string>>,
  ) => {
    if (envelope.encryptionContextHash !== JSON.stringify(binding))
      throw new Error("wrong binding");
    return JSON.parse(Buffer.from(envelope.ciphertext, "base64").toString("utf8")) as Value;
  },
  encrypt: async (value: unknown, binding: Readonly<Record<string, string>>) => ({
    algorithm: "AES-256-GCM" as const,
    authenticationTag: "tag",
    ciphertext: Buffer.from(JSON.stringify(value)).toString("base64"),
    encryptedDataKey: "key",
    encryptionContextHash: JSON.stringify(binding),
    iv: "iv",
    schemaVersion: 1 as const,
  }),
};

/** The error a call rejects with; `undefined` when it resolves, so the assertion fails. */
export const refusal = (call: Promise<unknown>) =>
  call.then(
    () => undefined,
    (error: unknown) => error,
  );

async function personRecords(principalId: Ulid, email: string) {
  return [
    ...createWithClaims(
      principalRecord({ createdAt: CREATED_AT, id: principalId, primaryEmail: email }),
      CREATED_AT,
    ),
    ...[
      passwordCredentialRecord({
        createdAt: CREATED_AT,
        passwordHash: await hashPassword(PASSWORD, DEFAULT_PASSWORD_PROFILE),
        principalId,
        version: 1,
      }),
      securityStateRecord({
        createdAt: CREATED_AT,
        credentialVersion: 1,
        emailVerifiedAt: CREATED_AT,
        principalId,
        sessionEpoch: 0,
        version: 1,
      }),
      bffFenceRecord({
        createdAt: CREATED_AT,
        principalId,
        principalStatus: "active",
        sessionEpoch: 0,
        version: 1,
      }),
    ].map((record) => ({ kind: "put" as const, record })),
  ];
}

/**
 * Ada and Grace, each with a password, over the production DynamoDB adapter on an in-memory
 * client, with the real identity application and account standing repository.
 */
export async function accountLifecycleHarness() {
  const fake = fakeDynamoDocumentClient();
  const database = makeDynamoDatabase(fake.client);
  // Seeds straight into the fake table so the fixture issues no database writes of its own.
  const seed = (operations: readonly TransactionOperation[]) => {
    for (const operation of operations) {
      if ("record" in operation) {
        fake.put(tableForItemType(operation.record.itemType), operation.record);
      }
    }
  };
  for (const [principalId, email] of [
    [ADA, ADA_EMAIL],
    [GRACE, GRACE_EMAIL],
  ] as const) {
    seed(await personRecords(principalId, email));
  }
  let clock = new Date("2026-07-28T01:00:00.000Z");
  const now = () => clock;
  const generateId = sequentialIds();
  const repository = makeIdentityRepository(database);
  const application = makeIdentityApplication(
    {
      accountStanding: makeAccountStandingRepository({ database, generateId, now }),
      encryptEmailPayload: plainSecrets.encrypt,
      generateId,
      mfaSecrets: plainSecrets,
      now,
      repository,
    },
    {
      actionLifetimeSeconds: 1_800,
      rateLimits: DEFAULT_IDENTITY_RATE_LIMIT_POLICIES,
      sessionAbsoluteLifetimeSeconds: 86_400,
      sessionIdleLifetimeSeconds: 3_600,
    },
  );
  const advance = (seconds: number) => {
    clock = new Date(clock.getTime() + seconds * 1_000);
  };
  const codeAt = (secret: string, offsetSteps = 0) =>
    hotp(base32Decode(secret), totpStep(clock) + offsetSteps);

  async function enroll(principalId = ADA) {
    const { secret } = await application.mfa.beginEnrollment({ password: PASSWORD, principalId });
    const { recoveryCodes } = await application.mfa.confirmEnrollment({
      code: codeAt(secret),
      principalId,
    });
    advance(30);
    return { recoveryCodes, secret };
  }

  /** Every queued email as its purpose, recipient, and link token, oldest first. */
  async function deliveries() {
    const sent = [];
    for (const item of fake.items("identity-email-outbox")) {
      const data = item.data as {
        actionId?: string;
        id: string;
        protectedPayload: ProtectedEnvelope;
        purpose: string;
      };
      const payload = await plainSecrets.decrypt<{ actionToken?: string; recipient: string }>(
        data.protectedPayload,
        {
          ...(data.actionId ? { actionId: data.actionId } : {}),
          deliveryId: data.id,
          purpose: data.purpose,
        },
      );
      sent.push({
        purpose: data.purpose,
        recipient: payload.recipient,
        token: payload.actionToken,
      });
    }
    return sent;
  }

  async function lastToken(purpose: string) {
    const token = (await deliveries()).findLast((delivery) => delivery.purpose === purpose)?.token;
    if (!token) throw new Error(`no ${purpose} email was queued`);
    return token;
  }

  async function withOrganization(
    members: readonly (readonly [Ulid, "admin" | "member" | "owner" | "viewer"])[],
    organization: { readonly id: Ulid; readonly name: string } = {
      id: ORGANIZATION,
      name: "Acme",
    },
  ) {
    const base = organizationRecord(organization.name);
    const record = withCanonicalRecordKeys({
      ...base,
      data: { ...base.data, id: organization.id, slug: organization.name.toLowerCase() },
    });
    seed([
      ...createWithClaims(record, CREATED_AT),
      ...members.map(([principalId, role]) => {
        const member = memberRecord(principalId, "active", role);
        return {
          kind: "put" as const,
          record: withCanonicalRecordKeys({
            ...member,
            data: { ...member.data, organizationId: organization.id },
          }),
        };
      }),
    ]);
  }

  const ownerOf = async (email: string) =>
    (await repository.principalForEmailHash(emailClaimValue(email)))?.data.id;

  return {
    advance,
    application,
    codeAt,
    database,
    deliveries,
    enroll,
    fake,
    generateId,
    lastToken,
    now,
    ownerOf,
    repository,
    withOrganization,
  };
}
