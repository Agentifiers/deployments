import { describe, expect, test } from "bun:test";
import type { DynamoDatabaseService } from "../client-types.ts";
import {
  NOW,
  OWNER,
  provisioningHarness,
  storedRecords,
  ulid,
  type ProvisioningHarness,
} from "../directory/test-support.ts";
import { newHumanPrincipalOperations } from "../identity/principal-creation.ts";
import { passwordCredentialRecord } from "../identity/record-builders.ts";
import type { Ulid } from "../ids.ts";
import type { PlatformRecord } from "../records/index.ts";
import { organizationMemberRecord } from "../tenancy-record-mapping.ts";
import { makeIdentityFederationAdministration } from "./administration.ts";
import type { FederatedIdentityClaims } from "./linking.ts";
import { createWithClaims } from "./operations.ts";
import { federationRecord } from "./record-builders.ts";
import { samlClaims, samlProviderRecord, SAML_ISSUER } from "./saml-test-support.ts";
import type { FederatedSignInOutcome } from "./sign-in-plan.ts";
import type { FederatedSignInStore } from "./sign-in.ts";
import { CONNECTION, ISSUER, federatedSignInStore, providerRecord } from "./test-support.ts";

const AT = NOW.toISOString();
const ADA_EMAIL = "ada@acme.example";
const ADA_OIDC: FederatedIdentityClaims = {
  email: ADA_EMAIL,
  emailVerified: true,
  issuer: ISSUER,
  name: "Ada Lovelace",
  protocol: "oidc",
  subject: "00u-ada",
};
const MAILBOX_CONFIRMATION_SENT = {
  expiresAt: "2026-10-08T12:30:00.000Z",
  kind: "mailbox-confirmation-sent",
  maskedEmail: "a***@acme.example",
} satisfies FederatedSignInOutcome;

interface LinkHarness extends ProvisioningHarness {
  /** Runs once, just before the sign-in store first tries to write a federated link. */
  readonly beforeLinkWrite: (change: () => void) => void;
  readonly sentEmails: unknown[];
  readonly signIn: (claims: FederatedIdentityClaims) => Promise<FederatedSignInOutcome>;
  readonly store: FederatedSignInStore;
}

/** Acme's directory and its active identity provider, over the real data layer. */
async function linkHarness(
  provider: (organizationId: Ulid) => PlatformRecord = (organizationId) =>
    providerRecord({ organizationId }),
): Promise<LinkHarness> {
  const harness = await provisioningHarness();
  harness.fake.put("control", provider(harness.acme));
  let beforeLinkWrite: (() => void) | undefined;
  const database: DynamoDatabaseService = {
    ...harness.database,
    transactWrite: (operations, token, signal) => {
      if (
        operations.some(
          (operation) =>
            operation.kind === "put" && operation.record.itemType === "principal-identity",
        )
      ) {
        beforeLinkWrite?.();
        beforeLinkWrite = undefined;
      }
      return harness.database.transactWrite(operations, token, signal);
    },
  };
  const { sentEmails, store } = federatedSignInStore(database, () => NOW);
  let attempts = 0;
  return {
    ...harness,
    beforeLinkWrite: (change) => {
      beforeLinkWrite = change;
    },
    sentEmails,
    signIn: async (claims) => {
      const lookupHash = `attempt-${(attempts += 1)}`;
      await store.beginTransaction({
        connectionId: CONNECTION,
        forceLogin: false,
        lookupHash,
        organizationId: harness.acme,
        returnTo: "/oauth2/authorize?client_id=deployments-web",
      });
      const transaction = await store.consumeTransaction({
        lookupHash,
        organizationId: harness.acme,
      });
      if (!transaction) throw new Error("expected a pending transaction");
      return store.completeSignIn({ claims, transaction });
    },
    store,
  };
}

async function provisionAda(harness: LinkHarness) {
  const created = await harness.directory.users.create(harness.acmeCaller, {
    active: true,
    displayName: "Ada Lovelace",
    email: ADA_EMAIL,
    externalId: "00u-ada",
    userName: ADA_EMAIL,
  });
  if (created.kind !== "ok") throw new Error(`expected a provisioned user, got ${created.reason}`);
  return ulid(created.value.id);
}

function securityOf(harness: LinkHarness, principalId: Ulid) {
  const [security] = storedRecords(harness.fake, "identity", "principal-security-state").filter(
    (record) => record.data.principalId === principalId,
  );
  if (!security) throw new Error("expected a security state");
  return security;
}

function linksOf(harness: LinkHarness, principalId: Ulid) {
  return storedRecords(harness.fake, "control", "principal-identity")
    .filter((link) => link.data.principalId === principalId)
    .map((link) => [link.data.organizationId, link.data.issuer, link.data.subject]);
}

function securityEventIds(harness: LinkHarness) {
  return new Set(
    storedRecords(harness.fake, "events", "identity-security-event").map(
      (event) => event.data.eventId,
    ),
  );
}

function addPassword(harness: LinkHarness, principalId: Ulid) {
  harness.fake.put(
    "identity",
    passwordCredentialRecord({
      createdAt: AT,
      passwordHash: "scrypt-hash",
      principalId,
      version: 1,
    }),
  );
}

describe("a SCIM-pristine principal links on its first federated sign-in", () => {
  test("over OIDC, without a mailbox email, ending earlier sessions", async () => {
    const harness = await linkHarness();
    const ada = await provisionAda(harness);
    const eventsBefore = securityEventIds(harness);

    const outcome = await harness.signIn(ADA_OIDC);

    expect(outcome).toEqual({
      expiresAt: "2026-10-09T12:00:00.000Z",
      kind: "signed-in",
      principalId: ada,
      sessionId: expect.any(String),
      sessionToken: "token-1",
    });
    expect(harness.sentEmails).toEqual([]);
    expect(linksOf(harness, ada)).toEqual([[harness.acme, ISSUER, "00u-ada"]]);
    expect(securityOf(harness, ada).data.sessionEpoch).toBe(1);
    expect(
      storedRecords(harness.fake, "identity", "identity-session").map((session) => [
        session.data.principalId,
        session.data.sessionEpoch,
      ]),
    ).toEqual([[ada, 1]]);
    expect(
      storedRecords(harness.fake, "events", "identity-security-event")
        .filter((event) => !eventsBefore.has(event.data.eventId))
        .map((event) => event.data.eventType)
        .toSorted(),
    ).toEqual([
      "identity.federated-identity-linked",
      "identity.session-created",
      "identity.sessions-invalidated",
    ]);
  });

  test("over SAML, without a mailbox email", async () => {
    const harness = await linkHarness((organizationId) => samlProviderRecord({ organizationId }));
    const ada = await provisionAda(harness);

    const outcome = await harness.signIn(samlClaims({ email: ADA_EMAIL, subject: "ada-saml" }));

    expect(outcome).toMatchObject({ kind: "signed-in", principalId: ada });
    expect(harness.sentEmails).toEqual([]);
    expect(linksOf(harness, ada)).toEqual([[harness.acme, SAML_ISSUER, "ada-saml"]]);
  });

  test("the next sign-in uses the link it made, and the account is no longer pristine", async () => {
    const harness = await linkHarness();
    const ada = await provisionAda(harness);
    await harness.signIn(ADA_OIDC);

    expect(await harness.signIn(ADA_OIDC)).toMatchObject({ kind: "signed-in", principalId: ada });
    expect(await harness.signIn({ ...ADA_OIDC, subject: "00u-ada-recreated" })).toEqual(
      MAILBOX_CONFIRMATION_SENT,
    );
  });
});

describe("any other existing account still confirms its mailbox", () => {
  const disqualifiers: readonly [string, (harness: LinkHarness, ada: Ulid) => Promise<void>][] = [
    ["a password credential", async (harness, ada) => addPassword(harness, ada)],
    [
      "a session epoch of 1",
      async (harness, ada) => {
        const security = securityOf(harness, ada);
        harness.fake.put("identity", {
          ...security,
          data: { ...security.data, sessionEpoch: 1, version: security.data.version + 1 },
        });
      },
    ],
    [
      "a membership in another organization",
      async (harness, ada) => {
        harness.fake.put(
          "control",
          organizationMemberRecord({
            createdAt: AT,
            organizationId: harness.rival,
            principalId: ada,
            role: "member",
            status: "active",
            updatedAt: AT,
            version: 1,
          }),
        );
      },
    ],
    [
      "an existing link in this organization",
      async (harness, ada) => {
        const link = federationRecord("principal-identity", {
          createdAt: AT,
          email: ADA_EMAIL,
          id: ulid("01ARZ3NDEKTSV4RRFFQ69G5FD1"),
          issuer: ISSUER,
          organizationId: harness.acme,
          principalId: ada,
          subject: "00u-ada-before",
          updatedAt: AT,
          version: 1,
        });
        await harness.database.transactWrite(createWithClaims(link, AT));
      },
    ],
    [
      "a removed membership",
      async (harness, ada) => {
        const changed = await harness.directory.users.change(harness.acmeCaller, ada, {
          active: false,
        });
        if (changed.kind !== "ok")
          throw new Error(`expected a deactivation, got ${changed.reason}`);
      },
    ],
  ];

  for (const [name, disqualify] of disqualifiers) {
    test(`a provisioned principal with ${name}`, async () => {
      const harness = await linkHarness();
      const ada = await provisionAda(harness);
      await disqualify(harness, ada);

      expect(await harness.signIn(ADA_OIDC)).toEqual(MAILBOX_CONFIRMATION_SENT);
      expect(harness.sentEmails).toEqual([
        { actionToken: "token-1", recipient: ADA_EMAIL, schemaVersion: 1 },
      ]);
      expect(linksOf(harness, ada).filter(([, , subject]) => subject === "00u-ada")).toEqual([]);
    });
  }

  test("a principal the directory adopted rather than provisioned", async () => {
    const harness = await linkHarness();
    const existing = ulid("01ARZ3NDEKTSV4RRFFQ69G5FD2");
    await harness.database.transactWrite(
      newHumanPrincipalOperations({
        createdAt: AT,
        eventId: ulid("01ARZ3NDEKTSV4RRFFQ69G5FD3"),
        mailbox: "unverified",
        primaryEmail: ADA_EMAIL,
        principalId: existing,
      }),
    );
    expect(await provisionAda(harness)).toBe(existing);

    expect(await harness.signIn(ADA_OIDC)).toEqual(MAILBOX_CONFIRMATION_SENT);
    expect(linksOf(harness, existing)).toEqual([]);
  });

  test("an active member the directory never saw", async () => {
    const harness = await linkHarness();
    const member = ulid("01ARZ3NDEKTSV4RRFFQ69G5FD4");
    await harness.database.transactWrite(
      newHumanPrincipalOperations({
        createdAt: AT,
        eventId: ulid("01ARZ3NDEKTSV4RRFFQ69G5FD5"),
        mailbox: "verified",
        primaryEmail: ADA_EMAIL,
        principalId: member,
      }),
    );
    harness.fake.put(
      "control",
      organizationMemberRecord({
        createdAt: AT,
        organizationId: harness.acme,
        principalId: member,
        role: "member",
        status: "active",
        updatedAt: AT,
        version: 1,
      }),
    );

    expect(await harness.signIn(ADA_OIDC)).toEqual(MAILBOX_CONFIRMATION_SENT);
    expect(linksOf(harness, member)).toEqual([]);
  });

  test("a pristine principal whose domain is no longer verified stays denied", async () => {
    const harness = await linkHarness();
    const ada = await provisionAda(harness);
    const [domain] = storedRecords(harness.fake, "control", "organization-login-domain").filter(
      (record) => record.data.organizationId === harness.acme,
    );
    if (!domain) throw new Error("expected Acme's login domain");
    await makeIdentityFederationAdministration({
      database: harness.database,
      now: () => NOW,
    }).removeLoginDomain({ organizationId: harness.acme, principalId: OWNER }, domain.data.id);

    expect(await harness.signIn(ADA_OIDC)).toEqual({
      kind: "denied",
      reason: "email_domain_not_verified",
    });
    expect(harness.sentEmails).toEqual([]);
    expect(linksOf(harness, ada)).toEqual([]);
  });

  test("a password set between the read and the write ends in mailbox confirmation", async () => {
    const harness = await linkHarness();
    const ada = await provisionAda(harness);
    harness.beforeLinkWrite(() => addPassword(harness, ada));

    expect(await harness.signIn(ADA_OIDC)).toEqual(MAILBOX_CONFIRMATION_SENT);
    expect(linksOf(harness, ada)).toEqual([]);
    expect(securityOf(harness, ada).data.sessionEpoch).toBe(0);
  });

  test("confirming the mailbox link ends sessions, so the epoch leaves 0 for good", async () => {
    const harness = await linkHarness();
    const ada = await provisionAda(harness);
    addPassword(harness, ada);
    await harness.signIn(ADA_OIDC);
    expect(securityOf(harness, ada).data.sessionEpoch).toBe(0);

    expect(await harness.store.confirmLink({ bindingHash: "attempt-1", token: "token-1" })).toEqual(
      { kind: "linked", organizationId: harness.acme },
    );
    expect(securityOf(harness, ada).data.sessionEpoch).toBe(1);
  });
});
