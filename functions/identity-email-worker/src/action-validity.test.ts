import { describe, expect, test } from "bun:test";
import {
  actionRecord,
  bffFenceRecord,
  identityRegistrationRecord,
  passwordCredentialRecord,
  pendingEmailDeliveryRecord,
  principalRecord,
  securityStateRecord,
  type IdentityRepository,
} from "@deployments-ai/db";
import { sha256 } from "@deployments-ai/identity";
import { linkedActionIsUsable } from "./action-validity.ts";

const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;
const ACTION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW" as never;
const DELIVERY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as never;
const NOW = new Date("2026-07-28T01:00:00.000Z");
const CREATED_AT = "2026-07-28T00:00:00.000Z";
const EXPIRES_AT = "2026-07-28T02:00:00.000Z";
const envelope = {
  algorithm: "AES-256-GCM" as const,
  authenticationTag: "tag",
  ciphertext: "ciphertext",
  encryptedDataKey: "key",
  encryptionContextHash: "context",
  iv: "iv",
  schemaVersion: 1 as const,
};

function delivery(purpose: "reset-password" | "verify-email") {
  return pendingEmailDeliveryRecord({
    actionId: ACTION_ID,
    createdAt: CREATED_AT,
    dispatchShard: "00",
    expiresAt: EXPIRES_AT,
    id: DELIVERY_ID,
    principalId: PRINCIPAL_ID,
    protectedPayload: envelope,
    purpose,
  });
}

describe("identity email linked actions", () => {
  test("accepts only a current pending verification action and registration", async () => {
    const email = "user@example.com";
    const token = "verification-token";
    const emailHash = sha256(email);
    const action = actionRecord({
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      id: ACTION_ID,
      principalId: PRINCIPAL_ID,
      purpose: "verify-email",
      targetEmail: email,
      targetEmailHash: emailHash,
      tokenHash: sha256(token),
    });
    const registration = identityRegistrationRecord({
      createdAt: CREATED_AT,
      email,
      emailHash,
      expiresAt: EXPIRES_AT,
      id: PRINCIPAL_ID,
      verificationEmailSentAt: CREATED_AT,
    });
    let currentAction = action;
    const repository = {
      identityActionForHash: () => Promise.resolve(currentAction),
      principalForEmailHash: () => Promise.resolve(undefined),
      registrationForEmailHash: () => Promise.resolve(registration),
    } as unknown as IdentityRepository;
    const input = {
      actionToken: token,
      delivery: delivery("verify-email"),
      now: NOW,
      recipient: email,
      repository,
    };

    expect(linkedActionIsUsable(input)).resolves.toBeTrue();
    currentAction = {
      ...action,
      data: { ...action.data, consumedAt: NOW.toISOString(), status: "consumed" },
    };
    expect(linkedActionIsUsable(input)).resolves.toBeFalse();
  });

  test("rejects reset actions issued for an earlier credential version", async () => {
    const email = "user@example.com";
    const token = "reset-token";
    const action = actionRecord({
      createdAt: CREATED_AT,
      expiresAt: EXPIRES_AT,
      id: ACTION_ID,
      issuedCredentialVersion: 1,
      principalId: PRINCIPAL_ID,
      purpose: "reset-password",
      tokenHash: sha256(token),
    });
    const principal = principalRecord({
      createdAt: CREATED_AT,
      id: PRINCIPAL_ID,
      primaryEmail: email,
    });
    const credential = passwordCredentialRecord({
      createdAt: CREATED_AT,
      passwordHash: "password-hash",
      principalId: PRINCIPAL_ID,
      version: 2,
    });
    const securityState = securityStateRecord({
      createdAt: CREATED_AT,
      credentialVersion: 2,
      emailVerifiedAt: CREATED_AT,
      principalId: PRINCIPAL_ID,
      sessionEpoch: 1,
      version: 2,
    });
    const fence = bffFenceRecord({
      createdAt: CREATED_AT,
      principalId: PRINCIPAL_ID,
      principalStatus: "active",
      sessionEpoch: 1,
      version: 2,
    });
    const repository = {
      bffFenceForPrincipal: () => Promise.resolve(fence),
      identityActionForHash: () => Promise.resolve(action),
      loadLoginMaterial: () => Promise.resolve({ credential, principal, securityState }),
    } as unknown as IdentityRepository;

    expect(
      linkedActionIsUsable({
        actionToken: token,
        delivery: delivery("reset-password"),
        now: NOW,
        recipient: email,
        repository,
      }),
    ).resolves.toBeFalse();
  });
});
