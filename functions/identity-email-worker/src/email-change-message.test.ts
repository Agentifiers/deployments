import { describe, expect, test } from "bun:test";
import {
  Ulid,
  emailChangeRecord,
  makeIdentityRepository,
  pendingEmailDeliveryRecord,
  principalRecord,
  securityStateRecord,
  type EmailChangeData,
  type PlatformRecord,
} from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import { sha256 } from "@deployments-ai/identity";
import { Schema } from "effect";
import { identityEmailMessage } from "./delivery-message.ts";

const id = Schema.decodeUnknownSync(Ulid);
const NOW = new Date("2026-07-28T01:30:00.000Z");
const AT = "2026-07-28T01:00:00.000Z";
const ADA = id("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const SECRET = "secret+value";
const TOKEN = `${ADA}.${SECRET}`;

const base = { createdAt: AT, id: ADA, principalId: ADA, updatedAt: AT, version: 1 };
const pending: EmailChangeData = {
  ...base,
  credentialVersion: 1,
  expiresAt: "2026-07-28T02:00:00.000Z",
  newEmail: "ada@new.example",
  state: "pending",
  tokenHash: sha256(SECRET),
};
const applied: EmailChangeData = {
  ...base,
  appliedAt: AT,
  newEmail: "ada@new.example",
  previousEmail: "ada@example.com",
  reportExpiresAt: "2026-08-04T01:00:00.000Z",
  reportTokenHash: sha256(SECRET),
  state: "applied",
  version: 2,
};

function message(
  purpose: "email-change-verify" | "email-changed",
  recipient: string,
  change: EmailChangeData | undefined,
  options: { readonly credentialVersion?: number; readonly token?: string } = {},
) {
  const records: PlatformRecord[] = [
    principalRecord({ createdAt: AT, id: ADA, primaryEmail: "ada@example.com" }),
    securityStateRecord({
      createdAt: AT,
      credentialVersion: options.credentialVersion ?? 1,
      emailVerifiedAt: AT,
      principalId: ADA,
      sessionEpoch: 0,
      version: 1,
    }),
    ...(change ? [emailChangeRecord(change)] : []),
  ];
  const { database } = evaluationMemoryDatabase(records);
  return identityEmailMessage(
    pendingEmailDeliveryRecord({
      createdAt: AT,
      dispatchShard: "03",
      expiresAt: "2026-07-28T02:00:00.000Z",
      id: id("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
      principalId: ADA,
      protectedPayload: {
        algorithm: "AES-256-GCM",
        authenticationTag: "tag",
        ciphertext: "ciphertext",
        encryptedDataKey: "key",
        encryptionContextHash: "hash",
        iv: "iv",
        schemaVersion: 1,
      },
      purpose,
    }),
    { actionToken: options.token ?? TOKEN, recipient, schemaVersion: 1 },
    {
      applicationOrigin: "https://app.deployments.ai",
      invitationForEmail: async () => undefined,
      issuer: "https://auth.deployments.ai",
      pendingFederationLink: async () => undefined,
      repository: makeIdentityRepository(database),
    },
    NOW,
  );
}

const DISCARD = { failureCategory: "linked-action-invalid", kind: "discard" } as const;

describe("email change messages", () => {
  test("sends the new address a confirm link while the change is pending", async () => {
    const result = await message("email-change-verify", "ada@new.example", pending);

    expect(result).toMatchObject({ kind: "send", recipient: "ada@new.example" });
    expect(result.kind === "send" ? result.content.text : "").toContain(
      `https://auth.deployments.ai/email-change/confirm#token=${encodeURIComponent(TOKEN)}`,
    );
  });

  test("sends the old address a report link naming the new one", async () => {
    const result = await message("email-changed", "ada@example.com", applied);

    expect(result).toMatchObject({ kind: "send", recipient: "ada@example.com" });
    const text = result.kind === "send" ? result.content.text : "";
    expect(text).toContain("signs in with ada@new.example");
    expect(text).toContain(
      `https://auth.deployments.ai/email-change/report#token=${encodeURIComponent(TOKEN)}`,
    );
  });

  test.each([
    [
      "a replaced request",
      "email-change-verify",
      "ada@new.example",
      pending,
      { token: `${ADA}.older` },
    ],
    [
      "a request voided by a password change",
      "email-change-verify",
      "ada@new.example",
      pending,
      { credentialVersion: 2 },
    ],
    ["a request already applied", "email-change-verify", "ada@new.example", applied, {}],
    ["a request for another address", "email-change-verify", "eve@example.com", pending, {}],
    [
      "a token naming another person",
      "email-change-verify",
      "ada@new.example",
      pending,
      { token: `01ARZ3NDEKTSV4RRFFQ69G5FAW.${SECRET}` },
    ],
    ["a missing change", "email-change-verify", "ada@new.example", undefined, {}],
    [
      "a notice for a change already reported",
      "email-changed",
      "ada@example.com",
      { ...base, emailRestored: true, reportedAt: AT, state: "reported" as const, version: 3 },
      {},
    ],
    ["a notice to the wrong address", "email-changed", "eve@example.com", applied, {}],
  ] as const)("discards %s", async (_label, purpose, recipient, change, options) => {
    expect(await message(purpose, recipient, change, options)).toEqual(DISCARD);
  });
});
