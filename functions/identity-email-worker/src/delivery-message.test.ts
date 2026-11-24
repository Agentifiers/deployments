import { describe, expect, test } from "bun:test";
import {
  IdentityFederationLinkRequestRecord,
  PrincipalRecord,
  Ulid,
  makeIdentityRepository,
  pendingEmailDeliveryRecord,
  pendingFederationLink,
  principalRecord,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "@deployments-ai/db";
import { evaluationMemoryDatabase } from "@deployments-ai/db/evaluation-testing";
import { sha256 } from "@deployments-ai/identity";
import { Schema } from "effect";
import {
  CONNECTION,
  ORGANIZATION,
  organizationRecord,
  providerRecord,
} from "../../../packages/db/src/identity-federation/test-support.ts";
import { identityEmailMessage } from "./delivery-message.ts";

const id = Schema.decodeUnknownSync(Ulid);
const NOW = new Date("2026-07-28T00:00:00.000Z");
const CREATED_AT = "2026-07-27T23:45:00.000Z";
const EXPIRES_AT = "2026-07-28T00:15:00.000Z";
const PRINCIPAL_ID = id("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const OTHER_PRINCIPAL_ID = id("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const RECIPIENT = "ada@acme.example";
const TOKEN = "dpl_fed_secret+token/value";

const delivery = pendingEmailDeliveryRecord({
  createdAt: CREATED_AT,
  dispatchShard: "03",
  expiresAt: EXPIRES_AT,
  id: id("01ARZ3NDEKTSV4RRFFQ69G5FAX"),
  principalId: PRINCIPAL_ID,
  protectedPayload: {
    algorithm: "AES-256-GCM",
    authenticationTag: "tag",
    ciphertext: "ciphertext",
    encryptedDataKey: "key",
    encryptionContextHash: "hash",
    iv: "iv",
    schemaVersion: 1,
  },
  purpose: "federated-identity-link",
});

function linkRequest(
  overrides: {
    readonly expiresAt?: string;
    readonly principalId?: Ulid;
    readonly status?: "consumed" | "pending";
  } = {},
) {
  const expiresAt = overrides.expiresAt ?? EXPIRES_AT;
  return Schema.decodeUnknownSync(IdentityFederationLinkRequestRecord)(
    withCanonicalRecordKeys({
      data: {
        bindingHash: "binding-hash",
        connectionId: CONNECTION,
        createdAt: CREATED_AT,
        expiresAt,
        id: id("01ARZ3NDEKTSV4RRFFQ69G5FAZ"),
        issuer: "https://acme.okta.com",
        organizationId: ORGANIZATION,
        principalId: overrides.principalId ?? PRINCIPAL_ID,
        status: overrides.status ?? "pending",
        subject: "00u-ada",
        tokenHash: sha256(TOKEN),
        updatedAt: CREATED_AT,
        version: 1,
      },
      itemType: "identity-federation-link-request",
      ttl: Math.floor(Date.parse(expiresAt) / 1_000),
    }),
  );
}

function human(
  overrides: {
    readonly id?: Ulid;
    readonly primaryEmail?: string;
    readonly status?: "active" | "disabled";
  } = {},
) {
  return principalRecord({
    createdAt: CREATED_AT,
    id: overrides.id ?? PRINCIPAL_ID,
    primaryEmail: overrides.primaryEmail ?? RECIPIENT,
    ...(overrides.status ? { status: overrides.status } : {}),
  });
}

const servicePrincipal = Schema.decodeUnknownSync(PrincipalRecord)(
  withCanonicalRecordKeys({
    data: {
      createdAt: CREATED_AT,
      id: PRINCIPAL_ID,
      kind: "service",
      primaryEmail: RECIPIENT,
      status: "active",
      updatedAt: CREATED_AT,
      version: 1,
    },
    itemType: "principal",
  }),
);

function message(
  records: readonly PlatformRecord[],
  actionToken: string | undefined,
  provider = providerRecord(),
) {
  const { database } = evaluationMemoryDatabase([provider, organizationRecord(), ...records]);
  return identityEmailMessage(
    delivery,
    {
      ...(actionToken === undefined ? {} : { actionToken }),
      recipient: RECIPIENT,
      schemaVersion: 1,
    },
    {
      applicationOrigin: "https://app.deployments.ai",
      invitationForEmail: async () => undefined,
      issuer: "https://auth.deployments.ai",
      pendingFederationLink: (token, now) => pendingFederationLink(database, token, now),
      repository: makeIdentityRepository(database),
    },
    NOW,
  );
}

describe("federated identity link emails", () => {
  test("sends a pending link request naming the organization and IdP with the confirm-link URL", async () => {
    const result = await message([linkRequest(), human()], TOKEN);

    expect(result).toMatchObject({
      content: { subject: "Confirm your Acme sign-in connection on Deployments.ai" },
      kind: "send",
      recipient: "ada@acme.example",
    });
    const text = result.kind === "send" ? result.content.text : "";
    expect(text).toContain(
      "Someone signed in through Acme Okta (acme.okta.com), the identity provider for Acme, using your email address.",
    );
    expect(text).toContain(
      "https://auth.deployments.ai/federation/confirm-link#token=dpl_fed_secret%2Btoken%2Fvalue",
    );
    expect(text).toContain("This single-use link expires July 28, 2026 at 12:15 AM UTC.");
  });

  test("discards a link request whose organization replaced its connection", async () => {
    const replaced = providerRecord({ connectionId: id("01ARZ3NDEKTSV4RRFFQ69G5FB9") });
    expect(await message([linkRequest(), human()], TOKEN, replaced)).toEqual({
      failureCategory: "linked-action-invalid",
      kind: "discard",
    });
  });

  test.each([
    ["consumed", [linkRequest({ status: "consumed" }), human()], TOKEN],
    ["expired", [linkRequest({ expiresAt: NOW.toISOString() }), human()], TOKEN],
    [
      "another principal's",
      [
        linkRequest({ principalId: OTHER_PRINCIPAL_ID }),
        human(),
        human({ id: OTHER_PRINCIPAL_ID }),
      ],
      TOKEN,
    ],
    ["re-addressed", [linkRequest(), human({ primaryEmail: "someone-else@acme.example" })], TOKEN],
    ["missing", [human()], TOKEN],
    ["tokenless", [linkRequest(), human()], undefined],
    ["disabled principal's", [linkRequest(), human({ status: "disabled" })], TOKEN],
    ["service principal's", [linkRequest(), servicePrincipal], TOKEN],
  ])("discards a %s link request without rendering it", async (_label, records, token) => {
    expect(await message(records, token)).toEqual({
      failureCategory: "linked-action-invalid",
      kind: "discard",
    });
  });
});
