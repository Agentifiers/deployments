import { describe, expect, test } from "bun:test";
import {
  makeDynamoDatabase,
  makeIdentityRepository,
  makeUniqueClaimRecord,
  tableForItemType,
  tableNamesFromEnvironment,
  uniqueClaimRequirements,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { DEFAULT_PASSWORD_PROFILE } from "@deployments-ai/identity";
import { DEFAULT_IDENTITY_RATE_LIMIT_POLICIES } from "./rate-limits.ts";
import { makeRegistrationApplication } from "./registration-application.ts";
import { principalSeed } from "./session-management.fixture.ts";

const OPERATOR = "01ARZ3NDEKTSV4RRFFQ69G5FB1" as Ulid;
const SEEDED_AT = "2026-07-25T12:00:00.000Z";
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const envelope = {
  algorithm: "AES-256-GCM" as const,
  authenticationTag: "tag",
  ciphertext: "ciphertext",
  encryptedDataKey: "encrypted-key",
  encryptionContextHash: "context-hash",
  iv: "iv",
  schemaVersion: 1 as const,
};

function identity(seed: readonly PlatformRecord[] = []) {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  for (const record of seed) {
    fake.put(tableForItemType(record.itemType), record);
    for (const requirement of uniqueClaimRequirements(record)) {
      fake.put(tables.control, makeUniqueClaimRecord(requirement, SEEDED_AT));
    }
  }
  let clock = new Date("2026-07-28T00:00:00.000Z");
  let sequence = 0;
  const sealed: unknown[] = [];
  const registration = makeRegistrationApplication(
    {
      encryptEmailPayload: async (value) => {
        sealed.push(value);
        return envelope;
      },
      generateId: () => {
        sequence += 1;
        return `01ARZ3NDEKTSV4RRFFQ69G6${CROCKFORD[Math.floor(sequence / 32) % 32]}${CROCKFORD[sequence % 32]}0` as Ulid;
      },
      now: () => clock,
      random: { bytes: (length) => new Uint8Array(length).fill(sequence) },
      repository: makeIdentityRepository(makeDynamoDatabase(fake.client, tables)),
    },
    {
      actionLifetimeSeconds: 1_800,
      passwordProfile: DEFAULT_PASSWORD_PROFILE,
      rateLimits: DEFAULT_IDENTITY_RATE_LIMIT_POLICIES,
      registrationLifetimeSeconds: 86_400,
    },
  );
  const deliveries = () =>
    fake
      .items(tables["identity-email-outbox"] ?? "identity-email-outbox")
      .map((item) => (item.data as { readonly purpose: string }).purpose);
  const reissueEvents = () =>
    fake.items(tables.events).flatMap((item) => {
      const data = item.data as {
        readonly actor?: { readonly id?: string };
        readonly eventType: string;
        readonly payload: unknown;
      };
      return data.eventType === "identity.verification-email-reissued"
        ? [[data.actor?.id ?? null, data.payload]]
        : [];
    });
  return {
    advance: (seconds: number) => {
      clock = new Date(clock.getTime() + seconds * 1_000);
    },
    deliveries,
    registration,
    reissueEvents,
    sealed,
  };
}

describe("operator verification resend", () => {
  test("queues a fresh verification email through the outbox under the self-service limits", async () => {
    const harness = identity();
    await harness.registration.signUp("pending@example.com");
    const pending = (await harness.registration.reissueVerification({
      actorPrincipalId: OPERATOR,
      email: "pending@example.com",
      kind: "reissue-verification",
      principalId: "01ARZ3NDEKTSV4RRFFQ69G6010" as Ulid,
      reason: "Lost the first email",
    })) as { readonly outcome: string };
    const signedUpAs = harness.sealed.length;
    const resend = (email = "PENDING@example.com") =>
      harness.registration.reissueVerification({
        actorPrincipalId: OPERATOR,
        email,
        kind: "reissue-verification",
        principalId: "01ARZ3NDEKTSV4RRFFQ69G6010" as Ulid,
        reason: "Lost the first email",
      });

    const outcomes: unknown[] = [pending];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      harness.advance(61);
      outcomes.push(await resend());
    }

    expect(outcomes.map((outcome) => (outcome as { outcome: string }).outcome)).toEqual([
      "rate-limited",
      "sent",
      "sent",
      "rate-limited",
      "rate-limited",
    ]);
    expect(outcomes[0]).toEqual({ outcome: "rate-limited", reason: "recently-sent" });
    expect(outcomes[3]).toEqual({ outcome: "rate-limited", reason: "hourly-limit" });
    expect(harness.deliveries()).toEqual(["verify-email", "verify-email", "verify-email"]);
    expect(harness.sealed.length - signedUpAs).toBe(2);
    expect(harness.reissueEvents()).toEqual([
      [OPERATOR, { reason: "Lost the first email" }],
      [OPERATOR, { reason: "Lost the first email" }],
    ]);
  });

  test("answers an existing person and an unknown sign-up without writing", async () => {
    const person = "01ARZ3NDEKTSV4RRFFQ69G5FC0" as Ulid;
    const harness = identity(principalSeed(person));

    expect(
      await Promise.all([
        harness.registration.reissueVerification({
          actorPrincipalId: OPERATOR,
          kind: "reissue-verification",
          principalId: person,
          reason: "Asked twice",
        }),
        harness.registration.reissueVerification({
          actorPrincipalId: OPERATOR,
          email: "nobody@example.com",
          kind: "reissue-verification",
          principalId: "01ARZ3NDEKTSV4RRFFQ69G6ZZ0" as Ulid,
          reason: "Asked twice",
        }),
      ]),
    ).toEqual([
      { emailVerified: true, outcome: "principal-exists" },
      { outcome: "sign-up-not-found" },
    ]);
    expect(harness.deliveries()).toEqual([]);
  });
});
