import { expect, mock, test } from "bun:test";
import {
  DatabaseError,
  pendingEmailDeliveryRecord,
  withCanonicalRecordKeys,
  type IdentityRepository,
} from "@deployments-ai/db";
import { queueIdentityEmailDelivery } from "./queue-delivery.ts";

const NOW = "2026-07-28T00:00:00.000Z";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;

test("a stale stream retry does not resend a delivery that another worker queued", async () => {
  const pending = pendingEmailDeliveryRecord({
    createdAt: NOW,
    dispatchShard: "00",
    expiresAt: "2026-07-28T01:00:00.000Z",
    id: ID,
    principalId: ID,
    protectedPayload: {
      algorithm: "AES-256-GCM",
      authenticationTag: "tag",
      ciphertext: "ciphertext",
      encryptedDataKey: "key",
      encryptionContextHash: "hash",
      iv: "iv",
      schemaVersion: 1,
    },
    purpose: "password-changed",
  });
  if (pending.data.status !== "pending") throw new Error("Expected a pending delivery fixture.");
  const { nextDispatchAt: _next, ...remaining } = pending.data;
  const queued = withCanonicalRecordKeys({
    ...pending,
    data: {
      ...remaining,
      queuedAt: NOW,
      status: "queued" as const,
      updatedAt: NOW,
      version: 2,
    },
  });
  const send = mock(async () => undefined);
  const transact = mock(() => Promise.resolve());
  const repository = {
    deliveryForId: () => Promise.resolve(queued),
    transact,
  } as unknown as IdentityRepository;

  await queueIdentityEmailDelivery({
    now: () => new Date(NOW),
    record: pending,
    repository,
    send,
  });

  expect(send).not.toHaveBeenCalled();
  expect(transact).not.toHaveBeenCalled();
});

test("a post-send state race is reconciled without sending the delivery again", async () => {
  const pending = pendingEmailDeliveryRecord({
    createdAt: NOW,
    dispatchShard: "00",
    expiresAt: "2026-07-28T01:00:00.000Z",
    id: ID,
    principalId: ID,
    protectedPayload: {
      algorithm: "AES-256-GCM",
      authenticationTag: "tag",
      ciphertext: "ciphertext",
      encryptedDataKey: "key",
      encryptionContextHash: "hash",
      iv: "iv",
      schemaVersion: 1,
    },
    purpose: "password-changed",
  });
  if (pending.data.status !== "pending") throw new Error("Expected a pending delivery fixture.");
  const { nextDispatchAt: _next, ...remaining } = pending.data;
  const queued = withCanonicalRecordKeys({
    ...pending,
    data: {
      ...remaining,
      queuedAt: NOW,
      status: "queued" as const,
      updatedAt: NOW,
      version: 2,
    },
  });
  let reads = 0;
  const send = mock(async () => undefined);
  const repository = {
    deliveryForId: () => Promise.resolve(reads++ === 0 ? pending : queued),
    transact: () =>
      Promise.reject(
        new DatabaseError({
          cause: new Error("ConditionalCheckFailedException"),
          message: "Delivery changed.",
          operation: "transact-write",
          reason: "conflict",
          table: "identity-email-outbox",
        }),
      ),
  } as unknown as IdentityRepository;

  await queueIdentityEmailDelivery({
    now: () => new Date(NOW),
    record: pending,
    repository,
    send,
  });

  expect(send).toHaveBeenCalledTimes(1);
});
