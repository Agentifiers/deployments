import { describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";
import {
  IDP_ENTITY_ID,
  attackerKey,
  idpKey,
  rolloverKey,
  type SigningKey,
} from "@deployments-ai/identity/saml-testing";
import { NOW, OWNER, RIVAL, provisioningHarness, ulid } from "../directory/test-support.ts";
import type { Ulid } from "../ids.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { makeUniqueClaimRecord } from "../unique-claims.ts";
import type {
  IdentityProviderSettings,
  SamlIdentityProviderSettings,
} from "./administration-provider.ts";
import { makeIdentityFederationAdministration } from "./administration.ts";
import type { FederatedIdentityClaims } from "./linking.ts";
import { createWithClaims } from "./operations.ts";
import { makeFederationReads } from "./reads.ts";
import { samlClaims } from "./saml-test-support.ts";
import type { FederatedSignInOutcome } from "./sign-in-plan.ts";
import {
  ENDPOINTS_WITHOUT_USERINFO,
  ISSUER,
  existingPrincipal,
  federatedSignInStore,
  providerRecord,
} from "./test-support.ts";

const ADA_EMAIL = "ada@acme.example";
const ADA_SUBJECT = "ada-subject";
const METADATA_URL = "https://idp.example.test/app/metadata";
const MAILBOX_CONFIRMATION_SENT = {
  expiresAt: "2026-10-08T12:30:00.000Z",
  kind: "mailbox-confirmation-sent",
  maskedEmail: "a***@acme.example",
} satisfies FederatedSignInOutcome;

function signingCertificate(key: SigningKey) {
  return {
    certificate: key.certificate,
    notAfter: "2036-01-01T00:00:00.000Z",
    sha256Fingerprint: new X509Certificate(Buffer.from(key.certificate, "base64")).fingerprint256,
  };
}

function samlSettings(
  [first, ...rest]: readonly [SigningKey, ...SigningKey[]],
  source: { readonly entityId?: string; readonly metadataUrl?: string } = {},
): SamlIdentityProviderSettings {
  return {
    displayName: "Acme SAML",
    jit: { kind: "enabled", role: "member" },
    metadata: {
      entityId: source.entityId ?? IDP_ENTITY_ID,
      signingCertificates: [signingCertificate(first), ...rest.map(signingCertificate)],
      singleSignOnRedirectUrl: "https://idp.example.test/sso",
    },
    ...(source.metadataUrl === undefined ? {} : { metadataUrl: source.metadataUrl }),
    protocol: "saml",
    unsolicitedSignIn: "disabled",
  };
}

/** Acme (acme.example, run by OWNER) and Rival (rival.example, run by RIVAL) over the real data layer. */
async function trustHarness() {
  const harness = await provisioningHarness();
  const administration = makeIdentityFederationAdministration({
    database: harness.database,
    now: () => NOW,
  });
  const reads = makeFederationReads(harness.database);
  const { sentEmails, store } = federatedSignInStore(harness.database, () => NOW);
  const administrator = (organizationId: Ulid) => ({
    organizationId,
    principalId: organizationId === harness.rival ? RIVAL : OWNER,
  });
  let attempts = 0;
  const signIn = async (organizationId: Ulid, claims: FederatedIdentityClaims) => {
    const lookupHash = `attempt-${(attempts += 1)}`;
    const provider = await administration.getIdentityProvider(organizationId);
    await store.beginTransaction({
      connectionId: provider.data.connectionId,
      forceLogin: false,
      lookupHash,
      organizationId,
      returnTo: "/oauth2/authorize?client_id=deployments-web",
    });
    const transaction = await store.consumeTransaction({ lookupHash, organizationId });
    if (!transaction) throw new Error("expected a pending transaction");
    return { lookupHash, outcome: await store.completeSignIn({ claims, transaction }) };
  };
  return {
    ...harness,
    configure: (organizationId: Ulid, settings: IdentityProviderSettings) =>
      administration.putIdentityProvider(administrator(organizationId), settings),
    connectionOf: async (organizationId: Ulid) =>
      (await administration.getIdentityProvider(organizationId)).data.connectionId,
    primaryEmailOf: async (principalId: Ulid) =>
      (await reads.principal(principalId))?.data.primaryEmail,
    sentEmails,
    signIn,
    /** The principal the sign-in opened a session for; anything else fails the test. */
    signedIn: async (organizationId: Ulid, claims: FederatedIdentityClaims) => {
      const { outcome } = await signIn(organizationId, claims);
      if (outcome.kind !== "signed-in") throw new Error(`expected a session, got ${outcome.kind}`);
      return outcome.principalId;
    },
    store,
    unlinkOnly: async (organizationId: Ulid) => {
      const [link, ...others] = (await administration.listLinks(organizationId, {})).items;
      if (!link || others.length > 0) throw new Error("expected exactly one federated link");
      await administration.deleteLink(administrator(organizationId), link.data.id);
    },
  };
}

describe("SAML links belong to the connection that pinned the signing certificates", () => {
  test("a certificate pasted under the same entity ID rotates the connection and reaches no link", async () => {
    const harness = await trustHarness();
    await harness.configure(harness.acme, samlSettings([idpKey]));
    const ada = await harness.signedIn(
      harness.acme,
      samlClaims({ email: ADA_EMAIL, subject: ADA_SUBJECT }),
    );
    const before = await harness.connectionOf(harness.acme);

    await harness.configure(harness.acme, samlSettings([attackerKey]));

    expect(await harness.connectionOf(harness.acme)).not.toBe(before);
    const forged = await harness.signIn(
      harness.acme,
      samlClaims({ email: ADA_EMAIL, key: attackerKey, subject: ADA_SUBJECT }),
    );
    expect(forged.outcome).toEqual(MAILBOX_CONFIRMATION_SENT);
    expect(harness.sentEmails).toEqual([
      { actionToken: "token-2", recipient: ADA_EMAIL, schemaVersion: 1 },
    ]);
    expect(await harness.primaryEmailOf(ada)).toBe(ADA_EMAIL);
  });

  test("certificates refreshed from the same metadata URL keep the connection and its links", async () => {
    const harness = await trustHarness();
    await harness.configure(harness.acme, samlSettings([idpKey], { metadataUrl: METADATA_URL }));
    const ada = await harness.signedIn(
      harness.acme,
      samlClaims({ email: ADA_EMAIL, subject: ADA_SUBJECT }),
    );
    const before = await harness.connectionOf(harness.acme);

    await harness.configure(
      harness.acme,
      samlSettings([rolloverKey], { metadataUrl: METADATA_URL }),
    );

    expect(await harness.connectionOf(harness.acme)).toBe(before);
    expect(
      await harness.signedIn(
        harness.acme,
        samlClaims({ email: "ada.renamed@acme.example", key: rolloverKey, subject: ADA_SUBJECT }),
      ),
    ).toBe(ada);
  });

  test("a SAML entity ID equal to the old OIDC issuer never reaches the OIDC links", async () => {
    const harness = await trustHarness();
    await harness.configure(harness.acme, {
      clientId: "0oa-client",
      discovered: {
        endpoints: ENDPOINTS_WITHOUT_USERINFO,
        signingAlgorithms: ["RS256"],
        tokenEndpointAuthMethod: "client_secret_basic",
      },
      displayName: "Acme Okta",
      issuer: ISSUER,
      jit: { kind: "enabled", role: "member" },
      protocol: "oidc",
      sealClientSecret: async () => ({
        algorithm: "AES-256-GCM",
        authenticationTag: "tag",
        ciphertext: "ciphertext",
        encryptedDataKey: "key",
        encryptionContextHash: "hash",
        iv: "iv",
        schemaVersion: 1,
      }),
    });
    const ada = await harness.signedIn(harness.acme, {
      email: ADA_EMAIL,
      emailVerified: true,
      issuer: ISSUER,
      protocol: "oidc",
      subject: ADA_SUBJECT,
    });

    await harness.configure(harness.acme, samlSettings([attackerKey], { entityId: ISSUER }));

    const forged = await harness.signIn(
      harness.acme,
      samlClaims({ email: ADA_EMAIL, issuer: ISSUER, key: attackerKey, subject: ADA_SUBJECT }),
    );
    expect(forged.outcome).toEqual(MAILBOX_CONFIRMATION_SENT);
    expect(await harness.primaryEmailOf(ada)).toBe(ADA_EMAIL);
  });

  test("another organization claiming the same entity ID neither squats nor blocks a subject", async () => {
    const harness = await trustHarness();
    await harness.configure(harness.rival, samlSettings([attackerKey]));
    const squatter = await harness.signedIn(
      harness.rival,
      samlClaims({ email: "eve@rival.example", key: attackerKey, subject: ADA_SUBJECT }),
    );
    await harness.configure(harness.acme, samlSettings([idpKey]));

    const ada = await harness.signedIn(
      harness.acme,
      samlClaims({ email: ADA_EMAIL, subject: ADA_SUBJECT }),
    );

    expect(await harness.primaryEmailOf(squatter)).toBe("eve@rival.example");
    expect(await harness.primaryEmailOf(ada)).toBe(ADA_EMAIL);
  });

  test("unlinking a SAML link lets the same subject link again through the mailbox", async () => {
    const harness = await trustHarness();
    await harness.configure(harness.acme, samlSettings([idpKey]));
    const claims = samlClaims({ email: ADA_EMAIL, subject: ADA_SUBJECT });
    const ada = await harness.signedIn(harness.acme, claims);

    await harness.unlinkOnly(harness.acme);

    const relink = await harness.signIn(harness.acme, claims);
    expect(relink.outcome).toEqual(MAILBOX_CONFIRMATION_SENT);
    expect(harness.sentEmails).toEqual([
      { actionToken: "token-2", recipient: ADA_EMAIL, schemaVersion: 1 },
    ]);
    expect(
      await harness.store.confirmLink({ bindingHash: relink.lookupHash, token: "token-2" }),
    ).toEqual({ kind: "linked", organizationId: harness.acme });
    expect(await harness.signedIn(harness.acme, claims)).toBe(ada);
  });
});

describe("OIDC links stored before SAML existed", () => {
  test("a stored OIDC link row still decodes and signs its principal in", async () => {
    const harness = await trustHarness();
    const ada = ulid("01ARZ3NDEKTSV4RRFFQ69G5FD9");
    harness.fake.put("control", providerRecord({ organizationId: harness.acme }));
    await harness.database.transactWrite(
      existingPrincipal(ADA_EMAIL, ada).flatMap((record) =>
        createWithClaims(record, record.data.createdAt),
      ),
    );
    const stored = withCanonicalRecordKeys({
      data: {
        createdAt: "2026-01-01T00:00:00.000Z",
        email: ADA_EMAIL,
        id: "01ARZ3NDEKTSV4RRFFQ69G5FDA",
        issuer: ISSUER,
        organizationId: harness.acme,
        principalId: ada,
        subject: "00u-ada",
        updatedAt: "2026-01-01T00:00:00.000Z",
        version: 1,
      },
      itemType: "principal-identity" as const,
    });
    harness.fake.put("control", stored);
    harness.fake.put(
      "control",
      makeUniqueClaimRecord(
        {
          namespace: `principal-identity:${ISSUER}`,
          ownerId: stored.data.id,
          ownerItemType: "principal-identity",
          ownerPk: stored.pk,
          ownerSk: stored.sk,
          ownerTable: "control",
          value: "00u-ada",
        },
        stored.data.createdAt,
      ),
    );

    expect(
      await harness.signedIn(harness.acme, {
        email: "ada.renamed@acme.example",
        emailVerified: true,
        issuer: ISSUER,
        protocol: "oidc",
        subject: "00u-ada",
      }),
    ).toBe(ada);
  });
});
