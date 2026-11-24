import { describe, expect, test } from "bun:test";
import { key } from "../keys.ts";
import type { OidcIdentityClaims } from "./linking.ts";
import {
  CONNECTION,
  EXISTING_PRINCIPAL,
  ISSUER,
  ORGANIZATION,
  OTHER_ORGANIZATION,
  existingPrincipal,
  id,
  memberRecord,
  providerRecord,
  signInHarness,
  verifiedDomainRecord,
} from "./test-support.ts";

const ALICE: OidcIdentityClaims = {
  email: "alice@acme.com",
  emailVerified: true,
  issuer: ISSUER,
  name: "Alice Example",
  protocol: "oidc",
  subject: "00u-alice",
};

async function consumedTransaction(harness: ReturnType<typeof signInHarness>, lookupHash = "h1") {
  await harness.store.beginTransaction({
    connectionId: CONNECTION,
    forceLogin: false,
    lookupHash,
    organizationId: ORGANIZATION,
    returnTo: "/oauth2/authorize?client_id=deployments-web",
  });
  const transaction = await harness.store.consumeTransaction({
    lookupHash,
    organizationId: ORGANIZATION,
  });
  if (!transaction) throw new Error("expected a pending transaction");
  return transaction;
}

describe("federation transactions", () => {
  test("are single use and bound to the organization on the callback path", async () => {
    const harness = signInHarness([providerRecord()]);
    await harness.store.beginTransaction({
      connectionId: CONNECTION,
      forceLogin: true,
      lookupHash: "h1",
      organizationId: ORGANIZATION,
      returnTo: "/oauth2/authorize",
    });
    expect(
      await harness.store.consumeTransaction({
        lookupHash: "h1",
        organizationId: OTHER_ORGANIZATION,
      }),
    ).toBeUndefined();
    const consumed = await harness.store.consumeTransaction({
      lookupHash: "h1",
      organizationId: ORGANIZATION,
    });
    expect(consumed?.data).toMatchObject({ forceLogin: true, status: "consumed", version: 2 });
    expect(
      await harness.store.consumeTransaction({ lookupHash: "h1", organizationId: ORGANIZATION }),
    ).toBeUndefined();
  });

  test("expire after their lifetime", async () => {
    const harness = signInHarness([providerRecord()]);
    await harness.store.beginTransaction({
      connectionId: CONNECTION,
      forceLogin: false,
      lookupHash: "h1",
      organizationId: ORGANIZATION,
      returnTo: "/oauth2/authorize",
    });
    harness.advance(600_000);
    expect(
      await harness.store.consumeTransaction({ lookupHash: "h1", organizationId: ORGANIZATION }),
    ).toBeUndefined();
  });

  test("go to exactly one of two concurrent consumers", async () => {
    const harness = signInHarness([providerRecord()]);
    await harness.store.beginTransaction({
      connectionId: CONNECTION,
      forceLogin: false,
      lookupHash: "h1",
      organizationId: ORGANIZATION,
      returnTo: "/oauth2/authorize",
    });
    const consumers = await Promise.all(
      Array.from({ length: 2 }, () =>
        harness.store.consumeTransaction({ lookupHash: "h1", organizationId: ORGANIZATION }),
      ),
    );
    expect(consumers.map((consumed) => consumed?.data.status ?? "lost").sort()).toEqual([
      "consumed",
      "lost",
    ]);
  });
});

describe("completeSignIn", () => {
  test("a first login creates the principal, link, JIT member, and a federated session", async () => {
    const harness = signInHarness([providerRecord(), verifiedDomainRecord()]);
    const outcome = await harness.store.completeSignIn({
      claims: ALICE,
      transaction: await consumedTransaction(harness),
    });
    if (outcome.kind !== "signed-in") throw new Error(`unexpected ${outcome.kind}`);
    const [principal] = harness.memory.of("principal");
    expect(principal?.data).toMatchObject({
      displayName: "Alice Example",
      kind: "human",
      primaryEmail: "alice@acme.com",
      status: "active",
    });
    expect(outcome.principalId).toBe(principal!.data.id);
    expect(harness.memory.of("principal-identity").map((link) => link.data)).toEqual([
      expect.objectContaining({
        issuer: ISSUER,
        organizationId: ORGANIZATION,
        principalId: outcome.principalId,
        subject: "00u-alice",
      }),
    ]);
    expect(harness.memory.of("organization-member").map((member) => member.data)).toEqual([
      expect.objectContaining({
        principalId: outcome.principalId,
        role: "member",
        status: "active",
      }),
    ]);
    expect(
      harness.memory.of("identity-session").map((session) => session.data.authentication),
    ).toEqual([
      {
        authenticatedAt: "2026-10-08T12:00:00.000Z",
        connectionId: CONNECTION,
        issuer: ISSUER,
        method: "federated",
        organizationId: ORGANIZATION,
        subject: "00u-alice",
      },
    ]);
  });

  test("10 concurrent first logins yield one principal, one link, and one membership", async () => {
    const harness = signInHarness([providerRecord(), verifiedDomainRecord()]);
    const transactions = await Promise.all(
      Array.from({ length: 10 }, (_, index) => consumedTransaction(harness, `h${index}`)),
    );
    const outcomes = await Promise.all(
      transactions.map((transaction) =>
        harness.store.completeSignIn({ claims: ALICE, transaction }),
      ),
    );
    const principalIds = new Set(
      outcomes.map((outcome) =>
        outcome.kind === "signed-in" ? outcome.principalId : outcome.kind,
      ),
    );
    expect(principalIds.size).toBe(1);
    expect(harness.memory.of("principal")).toHaveLength(1);
    expect(harness.memory.of("principal-identity")).toHaveLength(1);
    expect(harness.memory.of("organization-member")).toHaveLength(1);
    expect(harness.memory.of("identity-session")).toHaveLength(10);
    expect([...principalIds]).toEqual([harness.memory.of("principal")[0]!.data.id]);
  });

  test("an existing principal without a link gets a mailbox confirmation, never a session", async () => {
    const harness = signInHarness([
      providerRecord(),
      verifiedDomainRecord(),
      ...existingPrincipal("alice@acme.com"),
    ]);
    const outcome = await harness.store.completeSignIn({
      claims: ALICE,
      transaction: await consumedTransaction(harness),
    });
    expect(outcome).toEqual({
      expiresAt: "2026-10-08T12:30:00.000Z",
      kind: "mailbox-confirmation-sent",
      maskedEmail: "a***@acme.com",
    });
    expect(
      harness.memory
        .of("identity-federation-link-request")
        .map((request) => [request.data.bindingHash, request.data.status]),
    ).toEqual([["h1", "pending"]]);
    expect(harness.memory.of("identity-session")).toHaveLength(0);
    expect(harness.memory.of("principal-identity")).toHaveLength(0);
    expect(
      harness.memory.of("identity-email-delivery").map((delivery) => delivery.data.purpose),
    ).toEqual(["federated-identity-link"]);
    expect(harness.sentEmails).toEqual([
      { actionToken: "token-1", recipient: "alice@acme.com", schemaVersion: 1 },
    ]);
  });

  test("confirming the mailbox links, ends earlier sessions, and lets the next login in", async () => {
    const harness = signInHarness([
      providerRecord(),
      verifiedDomainRecord(),
      ...existingPrincipal("alice@acme.com"),
    ]);
    await harness.store.completeSignIn({
      claims: ALICE,
      transaction: await consumedTransaction(harness),
    });
    expect(await harness.store.confirmLink({ bindingHash: "other", token: "token-1" })).toEqual({
      kind: "browser-mismatch",
    });
    expect(await harness.store.confirmLink({ bindingHash: undefined, token: "token-1" })).toEqual({
      kind: "browser-mismatch",
    });
    expect(harness.memory.of("principal-security-state")[0]?.data.sessionEpoch).toBe(3);
    expect(await harness.store.confirmLink({ bindingHash: "h1", token: "token-1" })).toEqual({
      kind: "linked",
      organizationId: ORGANIZATION,
    });
    expect(await harness.store.confirmLink({ bindingHash: "h1", token: "token-1" })).toEqual({
      kind: "invalid",
    });
    expect(harness.memory.of("principal-security-state")[0]?.data.sessionEpoch).toBe(4);
    expect(harness.memory.of("identity-bff-revocation-fence")[0]?.data.sessionEpoch).toBe(4);
    const outcome = await harness.store.completeSignIn({
      claims: { ...ALICE, email: "renamed@acme.com" },
      transaction: await consumedTransaction(harness, "h2"),
    });
    expect(outcome).toMatchObject({ kind: "signed-in", principalId: EXISTING_PRINCIPAL });
    expect(harness.memory.of("identity-session")[0]?.data.sessionEpoch).toBe(4);
  });

  test("confirming a new subject replaces the principal's earlier link through the organization", async () => {
    const harness = signInHarness([
      providerRecord(),
      verifiedDomainRecord(),
      ...existingPrincipal("alice@acme.com"),
    ]);
    await harness.store.completeSignIn({
      claims: ALICE,
      transaction: await consumedTransaction(harness),
    });
    await harness.store.confirmLink({ bindingHash: "h1", token: "token-1" });
    await harness.store.completeSignIn({
      claims: { ...ALICE, subject: "00u-alice-recreated" },
      transaction: await consumedTransaction(harness, "h2"),
    });
    expect(await harness.store.confirmLink({ bindingHash: "h2", token: "token-2" })).toEqual({
      kind: "linked",
      organizationId: ORGANIZATION,
    });
    expect(harness.memory.of("principal-identity").map((link) => link.data.subject)).toEqual([
      "00u-alice-recreated",
    ]);
    const releasedClaim = harness.memory
      .of("unique-claim")
      .filter((claim) => claim.data.namespace === `principal-identity:${ISSUER}`)
      .map((claim) => claim.data.value);
    expect(releasedClaim).toEqual(["00u-alice-recreated"]);
  });

  test("a domain removed mid-login is denied on retry", async () => {
    const domain = verifiedDomainRecord();
    const harness = signInHarness([providerRecord(), domain]);
    const transaction = await consumedTransaction(harness);
    harness.memory.beforeCommit(() => harness.memory.remove(domain));
    expect(await harness.store.completeSignIn({ claims: ALICE, transaction })).toEqual({
      kind: "denied",
      reason: "email_domain_not_verified",
    });
    expect(harness.memory.of("principal")).toHaveLength(0);
  });

  test("JIT never revives a removed member", async () => {
    const harness = signInHarness([providerRecord(), verifiedDomainRecord()]);
    const first = await harness.store.completeSignIn({
      claims: ALICE,
      transaction: await consumedTransaction(harness),
    });
    if (first.kind !== "signed-in") throw new Error(`unexpected ${first.kind}`);
    const removed = memberRecord(first.principalId, "removed");
    harness.memory.put({ ...removed, data: { ...removed.data, version: 2 } });
    const again = await harness.store.completeSignIn({
      claims: ALICE,
      transaction: await consumedTransaction(harness, "h2"),
    });
    expect(again.kind).toBe("signed-in");
    expect(harness.memory.of("organization-member").map((member) => member.data)).toEqual([
      expect.objectContaining({ role: "admin", status: "removed", version: 2 }),
    ]);
  });

  test("a membership added concurrently is never overwritten by JIT", async () => {
    const harness = signInHarness([providerRecord(), verifiedDomainRecord()]);
    const first = await harness.store.completeSignIn({
      claims: { ...ALICE, email: "bob@acme.com", subject: "00u-bob" },
      transaction: await consumedTransaction(harness),
    });
    if (first.kind !== "signed-in") throw new Error(`unexpected ${first.kind}`);
    harness.memory.remove(harness.memory.of("organization-member")[0]!);
    harness.memory.beforeCommit(() =>
      harness.memory.put(memberRecord(first.principalId, "active")),
    );
    const second = await harness.store.completeSignIn({
      claims: { ...ALICE, email: "bob@acme.com", subject: "00u-bob" },
      transaction: await consumedTransaction(harness, "h2"),
    });
    expect(second.kind).toBe("signed-in");
    expect(harness.memory.of("organization-member").map((member) => member.data)).toEqual([
      expect.objectContaining({ role: "admin", status: "active", version: 1 }),
    ]);
  });

  test("a changed connection fails in-flight sign-ins", async () => {
    const harness = signInHarness([
      providerRecord({ connectionId: id("01ARZ3NDEKTSV4RRFFQ69G5FC9") }),
      verifiedDomainRecord(),
    ]);
    expect(
      await harness.store.completeSignIn({
        claims: ALICE,
        transaction: await consumedTransaction(harness),
      }),
    ).toEqual({ kind: "denied", reason: "connection_inactive" });
  });

  test("an attacker org's IdP cannot sign in as a principal in a domain it has not verified", async () => {
    const harness = signInHarness([
      providerRecord(),
      verifiedDomainRecord("attacker.example"),
      ...existingPrincipal("ceo@victim.com"),
    ]);
    expect(
      await harness.store.completeSignIn({
        claims: { ...ALICE, email: "ceo@victim.com", subject: "attacker-sub" },
        transaction: await consumedTransaction(harness),
      }),
    ).toEqual({ kind: "denied", reason: "email_domain_not_verified" });
    expect(harness.sentEmails).toEqual([]);
  });

  test("a verified domain admits only exact matches, never its subdomains", async () => {
    const harness = signInHarness([providerRecord(), verifiedDomainRecord("acme.com")]);
    expect(
      await harness.store.completeSignIn({
        claims: { ...ALICE, email: "alice@eu.acme.com" },
        transaction: await consumedTransaction(harness),
      }),
    ).toEqual({ kind: "denied", reason: "email_domain_not_verified" });
    expect(await harness.store.discover("alice@eu.acme.com")).toBeUndefined();
    expect((await harness.store.discover("alice@acme.com"))?.organizationId).toBe(ORGANIZATION);
  });
});

describe("discover", () => {
  test("answers by verified domain and active connection only", async () => {
    const harness = signInHarness([providerRecord(), verifiedDomainRecord()]);
    expect(await harness.store.discover("Someone@ACME.com")).toEqual({
      displayName: "Acme Okta",
      issuer: ISSUER,
      organizationId: ORGANIZATION,
      protocol: "oidc",
    });
    expect(await harness.store.discover("someone@other.com")).toBeUndefined();
    const disabled = signInHarness([
      providerRecord({ state: { disabledAt: "2026-10-08T12:00:00.000Z", kind: "disabled" } }),
      verifiedDomainRecord(),
    ]);
    expect(await disabled.store.discover("someone@acme.com")).toBeUndefined();
  });
});

test("link claims are keyed by issuer and subject in the control table", async () => {
  const harness = signInHarness([providerRecord(), verifiedDomainRecord()]);
  await harness.store.completeSignIn({
    claims: ALICE,
    transaction: await consumedTransaction(harness),
  });
  const claimKeys = harness.memory
    .of("unique-claim")
    .map((claim) => claim.pk)
    .filter((pk) => pk.includes("principal-identity") || pk.includes("federated-principal"));
  expect(claimKeys.sort()).toEqual(
    [
      key("UNIQUE", `organization:${ORGANIZATION}:federated-principal`),
      key("UNIQUE", `principal-identity:${ISSUER}`),
    ].sort(),
  );
});
