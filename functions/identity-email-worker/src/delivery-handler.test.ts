import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  OrganizationRecord,
  PrincipalRecord,
  organizationInvitationRecord,
  pendingEmailDeliveryRecord,
  withCanonicalRecordKeys,
  type IdentityRepository,
  type OrganizationInvitationEmailContext,
  type TransactionOperation,
} from "@deployments-ai/db";
import { sha256 } from "@deployments-ai/identity";
import { Schema } from "effect";
import { makeIdentityEmailWorkerHandler } from "./delivery-handler.ts";
import type { RenderedIdentityEmail } from "./delivery-message.ts";

const NOW = new Date("2026-07-28T00:00:00.000Z");
const CREATED_AT = "2026-07-27T00:00:00.000Z";
const EXPIRES_AT = "2026-08-03T00:00:00.000Z";
const DELIVERY_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV" as never;
const INVITATION_ID_TEXT = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const INVITATION_ID = INVITATION_ID_TEXT as never;
const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX" as never;
const INVITER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY" as never;
const RECIPIENT = "invitee@example.test";
const TOKEN = `dpl_inv_${INVITATION_ID_TEXT}_never-log-this+token/value`;

const delivery = pendingEmailDeliveryRecord({
  createdAt: CREATED_AT,
  dispatchShard: "07",
  expiresAt: EXPIRES_AT,
  id: DELIVERY_ID,
  invitationId: INVITATION_ID,
  organizationId: ORGANIZATION_ID,
  principalId: INVITER_ID,
  protectedPayload: {
    algorithm: "AES-256-GCM",
    authenticationTag: "tag",
    ciphertext: "ciphertext",
    encryptedDataKey: "key",
    encryptionContextHash: "hash",
    iv: "iv",
    schemaVersion: 1,
  },
  purpose: "organization-invitation",
});

function invitation(overrides: Readonly<Record<string, unknown>> = {}) {
  return organizationInvitationRecord({
    createdAt: CREATED_AT,
    email: RECIPIENT,
    expiresAt: EXPIRES_AT,
    id: INVITATION_ID,
    invitedByPrincipalId: INVITER_ID,
    organizationId: ORGANIZATION_ID,
    role: "admin",
    status: "pending",
    tokenHash: sha256(TOKEN),
    updatedAt: CREATED_AT,
    version: 1,
    ...overrides,
  } as never);
}

function context(
  invitationOverrides: Readonly<Record<string, unknown>> = {},
  displayName: string | undefined = "Ada Lovelace",
): OrganizationInvitationEmailContext {
  return {
    invitation: invitation(invitationOverrides),
    inviter: Schema.decodeUnknownSync(PrincipalRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: CREATED_AT,
          ...(displayName ? { displayName } : {}),
          id: INVITER_ID,
          kind: "human",
          primaryEmail: "ada@example.test",
          status: "active",
          updatedAt: CREATED_AT,
          version: 1,
        },
        itemType: "principal" as const,
      }),
    ),
    organization: Schema.decodeUnknownSync(OrganizationRecord)(
      withCanonicalRecordKeys({
        data: {
          createdAt: CREATED_AT,
          id: ORGANIZATION_ID,
          name: "Acme",
          slug: "acme",
          status: "active",
          updatedAt: CREATED_AT,
          version: 1,
        },
        itemType: "organization" as const,
      }),
    ),
  };
}

function run(loaded: OrganizationInvitationEmailContext | undefined, actionToken = TOKEN) {
  const transactions: (readonly TransactionOperation[])[] = [];
  const sent: { readonly content: RenderedIdentityEmail; readonly recipient: string }[] = [];
  const bindings: Readonly<Record<string, string>>[] = [];
  const repository = {
    deliveryForId: () => Promise.resolve(delivery),
    transact: async (operations: readonly TransactionOperation[]) => {
      transactions.push(operations);
    },
  } as unknown as IdentityRepository;
  const handler = makeIdentityEmailWorkerHandler({
    applicationOrigin: "https://app.deployments.ai",
    decrypt: async <Value>(_envelope: unknown, binding: Readonly<Record<string, string>>) => {
      bindings.push(binding);
      return { actionToken, recipient: RECIPIENT, schemaVersion: 1 } as Value;
    },
    invitationForEmail: async () => loaded,
    issuer: "https://auth.deployments.ai",
    maxReceiveCount: 5,
    now: () => NOW,
    pendingFederationLink: async () => undefined,
    repository,
    send: async (email) => {
      sent.push(email);
    },
  });
  return {
    bindings,
    result: handler({ Records: [{ body: DELIVERY_ID, messageId: "message-1" }] }),
    sent,
    transactions,
  };
}

function settledData(transactions: readonly (readonly TransactionOperation[])[]) {
  expect(transactions).toHaveLength(1);
  const operation = transactions[0]![0]!;
  if (operation.kind !== "put") throw new Error("Expected a full-record put.");
  return operation.record.data as Readonly<Record<string, unknown>>;
}

const consoleMethods = ["debug", "error", "info", "log", "trace", "warn"] as const;
let consoleSpies: ReturnType<typeof spyOn>[] = [];

function spyOnConsole() {
  consoleSpies = consoleMethods.map((method) => spyOn(console, method));
}

function expectTokenNeverLogged() {
  for (const spy of consoleSpies) {
    expect(JSON.stringify(spy.mock.calls)).not.toContain("never-log-this");
  }
}

afterEach(() => {
  for (const spy of consoleSpies) spy.mockRestore();
  consoleSpies = [];
  mock.restore();
});

describe("organization invitation email worker", () => {
  test("sends a valid invitation with a working acceptance link and settles it as sent", async () => {
    spyOnConsole();
    const { bindings, result, sent, transactions } = run(context());

    expect(result).resolves.toEqual({ batchItemFailures: [] });

    expect(bindings).toEqual([
      { deliveryId: DELIVERY_ID, invitationId: INVITATION_ID, purpose: "organization-invitation" },
    ]);
    expect(sent).toHaveLength(1);
    const email = sent[0]!;
    expect(email.recipient).toBe(RECIPIENT);
    expect(email.content.subject).toBe("Ada Lovelace invited you to Acme on Deployments.ai");
    const link = `https://app.deployments.ai/invitations/accept?invitation=${INVITATION_ID_TEXT}&token=${encodeURIComponent(TOKEN)}`;
    expect(email.content.text).toContain(link);
    const accepted = new URL(link);
    expect(accepted.searchParams.get("invitation")).toBe(INVITATION_ID);
    expect(accepted.searchParams.get("token")).toBe(TOKEN);
    expect(email.content.text).toContain("as admin");

    const data = settledData(transactions);
    expect(data).toMatchObject({ status: "sent", version: 2 });
    expect(data.protectedPayload).toBeUndefined();
    expect(JSON.stringify(transactions)).not.toContain("never-log-this");
    expectTokenNeverLogged();
  });

  test("falls back to the inviter email when no display name is set", async () => {
    const { result, sent } = run(context({}, ""));
    await result;
    expect(sent[0]?.content.subject).toBe("ada@example.test invited you to Acme on Deployments.ai");
  });

  test.each([
    ["revoked", context({ revokedAt: CREATED_AT, status: "revoked" }), TOKEN],
    ["accepted", context({ status: "accepted" }), TOKEN],
    ["expired", context({ expiresAt: "2026-07-27T12:00:00.000Z" }), TOKEN],
    ["missing", undefined, TOKEN],
    ["re-addressed", context({ email: "someone-else@example.test" }), TOKEN],
    ["mismatched-token", context(), `${TOKEN}-tampered`],
  ])("discards a %s invitation without sending it", async (_label, loaded, token) => {
    spyOnConsole();
    const { result, sent, transactions } = run(loaded, token);

    expect(result).resolves.toEqual({ batchItemFailures: [] });

    expect(sent).toEqual([]);
    const data = settledData(transactions);
    expect(data).toMatchObject({ failureCategory: "linked-action-invalid", status: "discarded" });
    expect(data.protectedPayload).toBeUndefined();
    expectTokenNeverLogged();
  });
});
