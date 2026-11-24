import { describe, expect, test } from "bun:test";
import type { PlatformRecord } from "@deployments-ai/db";
import { Schema } from "effect";
import {
  ENDPOINTS_WITHOUT_USERINFO,
  ORGANIZATION,
  providerRecord,
  verifiedDomainRecord,
} from "../../../packages/db/src/identity-federation/test-support.ts";
import { AuthorizeContinuation } from "./authorize-continuation.ts";
import type { FederationCallbackOutcome } from "./federation-completion.ts";
import { federationFixture, type ClaimRelease, type UserinfoAnswer } from "./federation.fixture.ts";

const ALICE = { email: "alice@acme.com", subject: "00u-alice" };
const RETURN_TO = Schema.decodeUnknownSync(AuthorizeContinuation)(
  `/oauth2/authorize?client_id=deployments-apps&organization_hint=${ORGANIZATION}`,
);
const SIGNED_IN: FederationCallbackOutcome = {
  kind: "signed-in",
  returnTo: RETURN_TO,
  sessionToken: "token-1",
};
const ONE_USERINFO_REQUEST = [{ authorization: "Bearer access-code-1", method: "GET" }];

function okta(userinfo: UserinfoAnswer): ClaimRelease {
  return { accessToken: "bearer", kind: "okta-code-flow", userinfo };
}

async function signInThrough(release: ClaimRelease, provider: PlatformRecord = providerRecord()) {
  const fixture = await federationFixture([provider, verifiedDomainRecord()], { release });
  const started = await fixture.federation.start({
    organizationId: ORGANIZATION,
    returnTo: RETURN_TO,
  });
  if (!started) throw new Error("expected the organization's connection to be active");
  const outcome = await fixture.federation.callback({
    bindingToken: started.bindingToken,
    organizationId: ORGANIZATION,
    query: fixture.identityProviderRedirect(started.location, ALICE),
  });
  const { memory } = fixture.harness;
  return {
    links: memory.of("principal-identity").map((link) => link.data.subject),
    outcome,
    principalEmails: memory.of("principal").map((principal) => principal.data.primaryEmail),
    sessions: memory.of("identity-session").length,
    userinfoRequests: fixture.userinfoRequests,
  };
}

describe("federated claim release", () => {
  test("an Okta code-flow sign-in reads the verified email from userinfo", async () => {
    expect(await signInThrough(okta({ emailVerified: true, kind: "claims" }))).toEqual({
      links: ["00u-alice"],
      outcome: SIGNED_IN,
      principalEmails: ["alice@acme.com"],
      sessions: 1,
      userinfoRequests: ONE_USERINFO_REQUEST,
    });
  });

  test("userinfo's address wins over the ID token's because only userinfo vouches for it", async () => {
    const { outcome, principalEmails } = await signInThrough(
      okta({ email: "alice.smith@acme.com", emailVerified: true, kind: "claims" }),
    );
    expect({ outcome, principalEmails }).toEqual({
      outcome: SIGNED_IN,
      principalEmails: ["alice.smith@acme.com"],
    });
  });

  test("a userinfo response about another user writes nothing", async () => {
    expect(await signInThrough(okta({ kind: "other-subject" }))).toEqual({
      links: [],
      outcome: { code: "userinfo_subject_mismatch", kind: "provider-response-invalid" },
      principalEmails: [],
      sessions: 0,
      userinfoRequests: ONE_USERINFO_REQUEST,
    });
  });

  test("an unreadable userinfo response fails the sign-in with userinfo_failed", async () => {
    const answers: readonly UserinfoAnswer[] = [
      { kind: "unauthorized" },
      { kind: "signed-jwt" },
      { kind: "missing-subject" },
    ];
    const outcomes = await Promise.all(
      answers.map(async (answer) => (await signInThrough(okta(answer))).outcome),
    );
    expect(outcomes).toEqual(
      Array(3).fill({ code: "userinfo_failed", kind: "provider-response-invalid" }),
    );
  });

  test("userinfo saying the address is unverified denies the sign-in", async () => {
    const { outcome, userinfoRequests } = await signInThrough(
      okta({ emailVerified: false, kind: "claims" }),
    );
    expect({ outcome, userinfoRequests }).toEqual({
      outcome: { kind: "rejected", reason: "email_unverified" },
      userinfoRequests: ONE_USERINFO_REQUEST,
    });
  });

  test("without a stored userinfo endpoint or a Bearer token, an Okta sign-in is denied as before", async () => {
    const saved = await signInThrough(
      okta({ emailVerified: true, kind: "claims" }),
      providerRecord({ endpoints: ENDPOINTS_WITHOUT_USERINFO }),
    );
    const tokenless = await signInThrough({
      accessToken: "absent",
      kind: "okta-code-flow",
      userinfo: { emailVerified: true, kind: "claims" },
    });
    expect(
      [saved, tokenless].map(({ outcome, userinfoRequests }) => ({ outcome, userinfoRequests })),
    ).toEqual([
      { outcome: { kind: "rejected", reason: "email_unverified" }, userinfoRequests: [] },
      { outcome: { kind: "rejected", reason: "email_unverified" }, userinfoRequests: [] },
    ]);
  });

  test("an ID token that states a verdict decides alone, without a userinfo request", async () => {
    const releases: readonly ClaimRelease[] = [
      { hostedDomain: "acme.com", kind: "google-workspace" },
      { kind: "entra-id" },
      { emailVerified: false, kind: "id-token" },
    ];
    const results = await Promise.all(
      releases.map(async (release) => {
        const { outcome, userinfoRequests } = await signInThrough(release);
        return { outcome, userinfoRequests };
      }),
    );
    expect(results).toEqual([
      { outcome: SIGNED_IN, userinfoRequests: [] },
      { outcome: SIGNED_IN, userinfoRequests: [] },
      { outcome: { kind: "rejected", reason: "email_unverified" }, userinfoRequests: [] },
    ]);
  });
});
