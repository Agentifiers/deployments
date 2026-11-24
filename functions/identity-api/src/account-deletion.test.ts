import { describe, expect, spyOn, test } from "bun:test";
import {
  deviceGrantRecord,
  oauthClientRecord,
  refreshRecords,
  type IdentityRecord,
  type Ulid,
} from "@deployments-ai/db";
import { sha256 } from "@deployments-ai/identity";
import { createWithClaims } from "../../../packages/db/src/identity-federation/operations.ts";
import { federationRecord } from "../../../packages/db/src/identity-federation/record-builders.ts";
import {
  memberRecord,
  verifiedDomainRecord,
} from "../../../packages/db/src/identity-federation/test-support.ts";
import { makeAccountAuthenticator } from "./account-authentication.ts";
import {
  ADA,
  ADA_EMAIL,
  GRACE,
  ORGANIZATION,
  PASSWORD,
  accountLifecycleHarness,
  refusal,
} from "./account-lifecycle.fixture.ts";
import { makeDeviceApplication } from "./device-application.ts";
import { makeOAuthApplication } from "./oauth-application.ts";

const AT = "2026-07-28T01:00:00.000Z";
const FAMILY = "01ARZ3NDEKTSV4RRFFQ69G5FE0" as Ulid;
const GRANT = "01ARZ3NDEKTSV4RRFFQ69G5FE1" as Ulid;
const SECOND_ORGANIZATION = "01ARZ3NDEKTSV4RRFFQ69G5FE2" as Ulid;
const THIRD_ORGANIZATION = "01ARZ3NDEKTSV4RRFFQ69G5FE3" as Ulid;
const FIRST_LINK = "01ARZ3NDEKTSV4RRFFQ69G5FE4" as Ulid;
const SECOND_LINK = "01ARZ3NDEKTSV4RRFFQ69G5FE5" as Ulid;
const ISSUER = "https://auth.deployments.ai";
const signer = { jwks: async () => ({ keys: [] }), sign: async () => "signed" };

/**
 * Ada holds a browser session, a console refresh family bound to it, a CLI refresh family, and an
 * approved device grant waiting to be redeemed; every credential kind deletion must end.
 */
async function signedInEverywhere() {
  const h = await accountLifecycleHarness();
  const signedIn = await h.application.signIn({ email: ADA_EMAIL, password: PASSWORD });
  if (signedIn.kind !== "signed-in") throw new Error("expected a session");
  const client = (clientId: string, grantTypes: string[]) =>
    oauthClientRecord({
      allowedScopes: ["offline_access", "openid"],
      clientId,
      createdAt: AT,
      grantTypes,
      name: clientId,
      redirectUris: ["http://127.0.0.1/callback"],
      requiredScopes: [],
      tokenEndpointAuthMethod: "none",
      type: "public",
      version: 1,
    });
  const refresh = (familyId: Ulid, browserSessionId?: Ulid) =>
    refreshRecords({
      audience: "https://api.deployments.ai",
      authenticationTime: AT,
      ...(browserSessionId ? { browserSessionId } : {}),
      clientId: browserSessionId ? "deployments-web" : "deployments-cli",
      createdAt: AT,
      expiresAt: "2026-08-28T00:00:00.000Z",
      familyId,
      principalId: ADA,
      scopes: ["offline_access", "openid"],
      sessionEpoch: 0,
      tokenHash: sha256(`refresh-${familyId}`),
      tokenId: h.generateId(),
    });
  const console = refresh(h.generateId(), signedIn.sessionId);
  const cli = refresh(FAMILY);
  const pending = deviceGrantRecord({
    clientId: "deployments-cli",
    createdAt: AT,
    deviceCodeHash: sha256("device-code"),
    expiresAt: "2026-07-28T01:10:00.000Z",
    id: GRANT,
    pollingIntervalSeconds: 5,
    requestedScopes: ["offline_access", "openid"],
    userCodeHash: sha256("USER-CODE"),
  });
  const approved: IdentityRecord<"oauth-device-grant"> = {
    ...pending,
    data: {
      ...pending.data,
      approvedAt: AT,
      approvedSessionEpoch: 0,
      authenticationTime: AT,
      claimedBySessionId: signedIn.sessionId,
      principalId: ADA,
      status: "approved",
      version: 2,
    },
  };
  for (const record of [
    client("deployments-cli", ["refresh_token", "urn:ietf:params:oauth:grant-type:device_code"]),
    client("deployments-web", ["refresh_token"]),
    console.family,
    console.token,
    cli.family,
    cli.token,
    approved,
  ]) {
    await h.database.transactWrite(createWithClaims(record, AT));
  }
  const lifetimes = {
    accessTokenSeconds: 300,
    issuer: ISSUER,
    refreshTokenSeconds: 2_592_000,
    resourceAudience: "https://api.deployments.ai",
  };
  const oauth = makeOAuthApplication(
    {
      encryptEmailPayload: async () => {
        throw new Error("no email expected");
      },
      generateId: h.generateId,
      now: h.now,
      repository: h.repository,
      signer,
    },
    {
      ...lifetimes,
      authorizationCodeSeconds: 60,
      authorizationRequestSeconds: 300,
      idTokenSeconds: 300,
    },
  );
  const device = makeDeviceApplication(
    { generateId: h.generateId, now: h.now, repository: h.repository, signer },
    {
      ...lifetimes,
      applicationOrigin: "https://app.deployments.ai",
      deviceLifetimeSeconds: 600,
      pollingIntervalSeconds: 5,
    },
  );
  const accountToken = makeAccountAuthenticator({
    now: h.now,
    repository: h.repository,
    verify: async () => ({
      client_id: "deployments-web",
      sid: console.family.data.id,
      sub: ADA,
    }),
  });
  const outcome = (call: Promise<unknown>) =>
    call.then(
      () => "works",
      (error: { code?: string }) => error.code ?? "failed",
    );
  /** What each credential Ada held can still do, without spending any of them. */
  const reach = async () => ({
    accountRoutes: (await accountToken("Bearer token")) ? "works" : "refused",
    browser: (await h.application.session(signedIn.sessionToken)) ? "works" : "refused",
  });
  const spend = async () => ({
    cliRefresh: await outcome(
      oauth.exchangeRefreshToken({
        clientId: "deployments-cli",
        refreshToken: `refresh-${FAMILY}`,
      }),
    ),
    device: await outcome(device.poll({ clientId: "deployments-cli", deviceCode: "device-code" })),
  });
  return { ...h, reach, signedIn, spend };
}

const member = async (
  h: Awaited<ReturnType<typeof accountLifecycleHarness>>,
  organizationId: Ulid,
  principalId: Ulid,
) =>
  (
    await h.database.getRecord("control", {
      pk: `ORG#${organizationId}`,
      sk: `ORGANIZATION-MEMBER#${principalId}`,
    })
  )?.data as { status: string } | undefined;

const deletion = (code?: string) => ({
  ...(code ? { code } : {}),
  password: PASSWORD,
  principalId: ADA,
});

describe("account deletion", () => {
  test("the person's credentials all work before deletion", async () => {
    const h = await signedInEverywhere();

    expect(await h.reach()).toEqual({ accountRoutes: "works", browser: "works" });
    expect(await h.spend()).toEqual({ cliRefresh: "works", device: "works" });
  });

  test("ends every session, refresh token, and device grant and frees the address", async () => {
    const h = await signedInEverywhere();

    await h.application.account.deleteAccount(deletion());

    expect(await h.reach()).toEqual({ accountRoutes: "refused", browser: "refused" });
    expect(await h.spend()).toEqual({ cliRefresh: "invalid_grant", device: "invalid_grant" });
    expect(await h.ownerOf(ADA_EMAIL)).toBeUndefined();
    expect(
      await refusal(h.application.signIn({ email: ADA_EMAIL, password: PASSWORD })),
    ).toBeDefined();
  });

  test("with MFA on, needs a code; then leaves an archived principal with no personal data", async () => {
    const h = await signedInEverywhere();
    const { secret } = await h.enroll();

    expect(await refusal(h.application.account.deleteAccount(deletion()))).toMatchObject({
      code: "invalid_request",
    });
    expect(
      await refusal(h.application.account.deleteAccount({ ...deletion(), password: "wrong" })),
    ).toMatchObject({ code: "access_denied" });
    await h.application.account.deleteAccount(deletion(h.codeAt(secret)));

    const principal = await h.repository.principalForId(ADA);
    const material = await h.repository.loadLoginMaterial(ADA);
    expect({
      credential: material.credential,
      displayName: principal?.data.displayName,
      factor: await h.repository.mfaFactorForPrincipal(ADA),
      fence: (await h.repository.bffFenceForPrincipal(ADA))?.data.principalStatus,
      primaryEmail: principal?.data.primaryEmail,
      status: principal?.data.status,
    }).toEqual({
      credential: undefined,
      displayName: undefined,
      factor: undefined,
      fence: "archived",
      primaryEmail: undefined,
      status: "archived",
    });
    expect((await h.deliveries()).at(-1)).toEqual({
      purpose: "account-deleted",
      recipient: ADA_EMAIL,
      token: undefined,
    });
  });

  test("a deletion that fails after accepting a code has still spent it", async () => {
    const h = await signedInEverywhere();
    const { recoveryCodes } = await h.enroll();
    const code = recoveryCodes[0]!;
    h.fake.failNextTransaction(
      (input) =>
        input.TransactItems?.some((item) => item.Put?.Item?.itemType === "principal") === true,
      () => new Error("the account write failed"),
    );

    expect(await refusal(h.application.account.deleteAccount(deletion(code)))).toBeDefined();
    expect((await h.repository.principalForId(ADA))?.data.status).toBe("active");
    expect(await refusal(h.application.account.deleteAccount(deletion(code)))).toMatchObject({
      code: "access_denied",
      message: "The code is incorrect.",
    });
  });

  test("the only owner of an organization is blocked and told how to unblock it", async () => {
    const h = await signedInEverywhere();
    await h.withOrganization([
      [ADA, "owner"],
      [GRACE, "member"],
    ]);

    expect((await h.application.account.profile(ADA)).deletion).toEqual({
      blockers: [{ kind: "sole-owner", organizationId: ORGANIZATION, organizationName: "Acme" }],
      kind: "blocked",
    });
    expect(await refusal(h.application.account.deleteAccount(deletion()))).toMatchObject({
      message:
        "You are the only owner of Acme. Make someone else an owner or erase the organization first.",
      status: 409,
    });
    expect(await h.reach()).toEqual({ accountRoutes: "works", browser: "works" });
    expect(await h.ownerOf(ADA_EMAIL)).toBe(ADA);
  });

  test("a co-owner leaves the organization, which keeps its other owner", async () => {
    const h = await signedInEverywhere();
    await h.withOrganization([
      [ADA, "owner"],
      [GRACE, "owner"],
    ]);
    expect((await h.application.account.profile(ADA)).deletion).toEqual({
      kind: "allowed",
      leaves: [{ organizationId: ORGANIZATION, organizationName: "Acme" }],
    });

    await h.application.account.deleteAccount(deletion());

    expect({
      ada: (await member(h, ORGANIZATION, ADA))?.status,
      grace: (await member(h, ORGANIZATION, GRACE))?.status,
    }).toEqual({
      ada: "removed",
      grace: "active",
    });
  });

  test("leaves an organization that added the person while deletion was under way", async () => {
    const h = await signedInEverywhere();
    await h.withOrganization([[GRACE, "owner"]]);
    const send = h.fake.client.send.bind(h.fake.client);
    const addedMidway = spyOn(h.fake.client, "send").mockImplementation((async (
      command: Parameters<typeof send>[0],
    ) => {
      const result = await send(command);
      const items = (
        command.input as { TransactItems?: { Put?: { Item?: { itemType?: string } } }[] }
      ).TransactItems;
      if (items?.some((item) => item.Put?.Item?.itemType === "identity-rate-limit")) {
        addedMidway.mockRestore();
        h.fake.put("control", memberRecord(ADA, "active", "member"));
      }
      return result;
    }) as typeof send);

    await h.application.account.deleteAccount(deletion()).finally(() => addedMidway.mockRestore());

    expect({
      membership: (await member(h, ORGANIZATION, ADA))?.status,
      principal: (await h.repository.principalForId(ADA))?.data.status,
    }).toEqual({ membership: "removed", principal: "archived" });
  });

  test("names every organization that still blocks when ownership changed during deletion", async () => {
    const h = await signedInEverywhere();
    await h.withOrganization([
      [ADA, "owner"],
      [GRACE, "owner"],
    ]);
    await h.withOrganization(
      [
        [ADA, "owner"],
        [GRACE, "owner"],
      ],
      { id: SECOND_ORGANIZATION, name: "Globex" },
    );
    await h.withOrganization(
      [
        [ADA, "owner"],
        [GRACE, "owner"],
      ],
      { id: THIRD_ORGANIZATION, name: "Initech" },
    );
    const send = h.fake.client.send.bind(h.fake.client);
    const graceLeavesTheRest = spyOn(h.fake.client, "send").mockImplementation((async (
      command: Parameters<typeof send>[0],
    ) => {
      const result = await send(command);
      const items = (command.input as { TransactItems?: { Put?: { Item?: { sk?: string } } }[] })
        .TransactItems;
      if (items?.some((item) => item.Put?.Item?.sk === `ORGANIZATION-MEMBER#${ADA}`)) {
        graceLeavesTheRest.mockRestore();
        for (const organizationId of [SECOND_ORGANIZATION, THIRD_ORGANIZATION]) {
          h.fake.delete("control", {
            pk: `ORG#${organizationId}`,
            sk: `ORGANIZATION-MEMBER#${GRACE}`,
          });
        }
      }
      return result;
    }) as typeof send);

    const refused = await refusal(h.application.account.deleteAccount(deletion())).finally(() =>
      graceLeavesTheRest.mockRestore(),
    );
    expect(refused).toMatchObject({
      message:
        "You are the only owner of Globex and Initech. Make someone else an owner or erase each of them first.",
      status: 409,
    });
    expect({
      acme: (await member(h, ORGANIZATION, ADA))?.status,
      principal: (await h.repository.principalForId(ADA))?.data.status,
    }).toEqual({ acme: "removed", principal: "active" });
  });

  test("deletes federated identity links and their claims with the account", async () => {
    const h = await signedInEverywhere();
    await h.withOrganization([[GRACE, "owner"]]);
    await h.withOrganization([[GRACE, "owner"]], { id: SECOND_ORGANIZATION, name: "Globex" });
    await h.database.transactWrite([
      { kind: "put", record: memberRecord(ADA, "removed", "member") },
      ...createWithClaims(verifiedDomainRecord("example.com", SECOND_ORGANIZATION), AT),
    ]);
    const links = [
      [FIRST_LINK, ORGANIZATION, "okta|ada"],
      [SECOND_LINK, SECOND_ORGANIZATION, "globex|ada"],
    ] as const;
    for (const [linkId, organizationId, subject] of links) {
      await h.database.transactWrite(
        createWithClaims(
          federationRecord("principal-identity", {
            createdAt: AT,
            id: linkId,
            issuer: "https://idp.example",
            organizationId,
            principalId: ADA,
            subject,
            updatedAt: AT,
            version: 1,
          }),
          AT,
        ),
      );
    }
    const linkClaims = () =>
      h.fake
        .items("control")
        .filter(
          (item) =>
            item.itemType === "principal-identity" ||
            (item.data as { ownerItemType?: string }).ownerItemType === "principal-identity",
        );
    expect(linkClaims()).toHaveLength(6);

    await h.application.account.deleteAccount(deletion());

    expect({
      left: linkClaims(),
      principal: (await h.repository.principalForId(ADA))?.data.status,
    }).toEqual({ left: [], principal: "archived" });
  });

  test("a change the old address can still report blocks deletion until its window closes", async () => {
    const h = await signedInEverywhere();
    await h.application.account.requestEmailChange({
      newEmail: "ada@new.example",
      password: PASSWORD,
      principalId: ADA,
    });
    await h.application.account.confirmEmailChange({
      token: await h.lastToken("email-change-verify"),
    });

    expect((await h.application.account.profile(ADA)).deletion).toEqual({
      blockers: [{ kind: "held", until: "2026-08-04T01:00:00.000Z" }],
      kind: "blocked",
    });
    expect(await refusal(h.application.account.deleteAccount(deletion()))).toMatchObject({
      status: 409,
    });
    expect(await h.ownerOf("ada@new.example")).toBe(ADA);
    expect(
      await h.application.account.reportEmailChange({ token: await h.lastToken("email-changed") }),
    ).toEqual({ emailRestored: true });
  });

  test("a pending email change dies with the account", async () => {
    const h = await signedInEverywhere();
    await h.application.account.requestEmailChange({
      newEmail: "ada@new.example",
      password: PASSWORD,
      principalId: ADA,
    });
    const token = await h.lastToken("email-change-verify");

    await h.application.account.deleteAccount(deletion());

    expect(await refusal(h.application.account.confirmEmailChange({ token }))).toMatchObject({
      code: "invalid_grant",
    });
    expect(await h.ownerOf("ada@new.example")).toBeUndefined();
  });
});
