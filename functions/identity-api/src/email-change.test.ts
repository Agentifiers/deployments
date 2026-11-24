import { describe, expect, test } from "bun:test";
import { createWithClaims } from "../../../packages/db/src/identity-federation/operations.ts";
import { federationRecord } from "../../../packages/db/src/identity-federation/record-builders.ts";
import {
  ADA,
  ADA_EMAIL,
  GRACE,
  GRACE_EMAIL,
  ORGANIZATION,
  PASSWORD,
  accountLifecycleHarness,
  refusal,
} from "./account-lifecycle.fixture.ts";
import { emailChangeTransitions, viewEmailChange } from "./email-change.ts";

const NEW_EMAIL = "ada@new.example";
const request = (code?: string) => ({
  ...(code ? { code } : {}),
  newEmail: "  Ada@New.Example ",
  password: PASSWORD,
  principalId: ADA,
});

describe("email change state machine", () => {
  const at = new Date("2026-07-28T01:00:00.000Z");
  const pending = emailChangeTransitions.request({
    at,
    credentialVersion: 1,
    newEmail: NEW_EMAIL,
    previous: undefined,
    principalId: ADA,
    tokenHash: "a".repeat(64),
  });

  test("a request is pending for an hour, then void; a password change voids it at once", () => {
    expect(viewEmailChange(undefined, at, 1).kind).toBe("none");
    expect(viewEmailChange(pending, at, 1).kind).toBe("pending");
    expect(viewEmailChange(pending, new Date(at.getTime() + 3_599_000), 1).kind).toBe("pending");
    expect(viewEmailChange(pending, new Date(at.getTime() + 3_600_000), 1).kind).toBe("void");
    expect(viewEmailChange(pending, at, 2).kind).toBe("void");
  });

  test("each transition advances the version and keeps the creation time", () => {
    const later = new Date(at.getTime() + 60_000);
    const cancelled = emailChangeTransitions.cancel(pending, later);
    const applied = emailChangeTransitions.apply(pending, {
      at: later,
      previousEmail: ADA_EMAIL,
      reportTokenHash: "b".repeat(64),
    });
    const reported = emailChangeTransitions.report(applied, later, true);

    expect([pending, cancelled, applied, reported].map((change) => change.version)).toEqual([
      1, 2, 2, 3,
    ]);
    expect(new Set([cancelled, applied, reported].map((change) => change.createdAt))).toEqual(
      new Set([pending.createdAt]),
    );
    expect(viewEmailChange(cancelled, later, 1).kind).toBe("settled");
    expect(viewEmailChange(applied, later, 1).kind).toBe("applied");
    expect(applied.reportExpiresAt).toBe("2026-08-04T01:01:00.000Z");
    expect(viewEmailChange(reported, later, 1).kind).toBe("settled");
  });
});

describe("requesting an email change", () => {
  test("proves the password, then mails only the new address and leaves the email unchanged", async () => {
    const h = await accountLifecycleHarness();

    const started = await h.application.account.requestEmailChange(request());

    expect(started).toEqual({ email: NEW_EMAIL, expiresAt: "2026-07-28T02:00:00.000Z" });
    expect(
      (await h.deliveries()).map(({ purpose, recipient }) => ({ purpose, recipient })),
    ).toEqual([{ purpose: "email-change-verify", recipient: NEW_EMAIL }]);
    expect(await h.lastToken("email-change-verify")).toStartWith(`${ADA}.`);
    expect(await h.application.account.profile(ADA)).toMatchObject({
      email: ADA_EMAIL,
      emailChange: { kind: "available" },
      pendingEmail: { email: NEW_EMAIL, expiresAt: "2026-07-28T02:00:00.000Z" },
    });
    expect(await h.ownerOf(NEW_EMAIL)).toBeUndefined();
  });

  test("refuses a wrong password and the current address", async () => {
    const h = await accountLifecycleHarness();

    expect(
      await refusal(h.application.account.requestEmailChange({ ...request(), password: "wrong" })),
    ).toMatchObject({ code: "access_denied" });
    expect(
      await refusal(
        h.application.account.requestEmailChange({ ...request(), newEmail: ADA_EMAIL }),
      ),
    ).toMatchObject({ message: "That is already your email address." });
    expect(await h.deliveries()).toEqual([]);
  });

  test("an address another person holds is answered like a free one; only confirming refuses it", async () => {
    const h = await accountLifecycleHarness();

    expect(
      await h.application.account.requestEmailChange({ ...request(), newEmail: GRACE_EMAIL }),
    ).toEqual({ email: GRACE_EMAIL, expiresAt: "2026-07-28T02:00:00.000Z" });
    expect(
      (await h.deliveries()).map(({ purpose, recipient }) => ({ purpose, recipient })),
    ).toEqual([{ purpose: "email-change-verify", recipient: GRACE_EMAIL }]);
    expect(
      await refusal(
        h.application.account.confirmEmailChange({
          token: await h.lastToken("email-change-verify"),
        }),
      ),
    ).toMatchObject({ status: 409 });
    expect({ ada: await h.ownerOf(ADA_EMAIL), grace: await h.ownerOf(GRACE_EMAIL) }).toEqual({
      ada: ADA,
      grace: GRACE,
    });
  });

  test("with MFA on, needs a fresh code and spends it so it cannot be replayed", async () => {
    const h = await accountLifecycleHarness();
    const { secret } = await h.enroll();
    const code = h.codeAt(secret);

    expect(await refusal(h.application.account.requestEmailChange(request()))).toMatchObject({
      code: "invalid_request",
    });
    await h.application.account.requestEmailChange(request(code));

    expect(await refusal(h.application.account.requestEmailChange(request(code)))).toMatchObject({
      code: "access_denied",
    });
  });

  test("a newer request replaces the older one, whose link stops working", async () => {
    const h = await accountLifecycleHarness();
    await h.application.account.requestEmailChange(request());
    const older = await h.lastToken("email-change-verify");
    await h.application.account.requestEmailChange({ ...request(), newEmail: "ada@newer.example" });

    expect(await refusal(h.application.account.confirmEmailChange({ token: older }))).toMatchObject(
      { code: "invalid_grant" },
    );
    await h.application.account.confirmEmailChange({
      token: await h.lastToken("email-change-verify"),
    });
    expect(await h.ownerOf("ada@newer.example")).toBe(ADA);
  });

  test("a cancelled, expired, or password-voided request cannot be confirmed", async () => {
    for (const end of ["cancel", "expire", "password"] as const) {
      const h = await accountLifecycleHarness();
      await h.application.account.requestEmailChange(request());
      const token = await h.lastToken("email-change-verify");
      if (end === "cancel") await h.application.account.cancelEmailChange(ADA);
      if (end === "expire") h.advance(3_600);
      if (end === "password") {
        await h.application.changePassword({
          currentPassword: PASSWORD,
          password: "a different long passphrase",
          principalId: ADA,
        });
      }

      expect(await refusal(h.application.account.confirmEmailChange({ token }))).toMatchObject({
        code: "invalid_grant",
      });
      expect((await h.application.account.profile(ADA)).pendingEmail).toBeUndefined();
      expect(await h.ownerOf(ADA_EMAIL)).toBe(ADA);
    }
  });

  test("an address an organization's identity provider manages names who changes it", async () => {
    const h = await accountLifecycleHarness();
    await h.withOrganization([[ADA, "member"]]);
    await h.database.transactWrite(
      createWithClaims(
        federationRecord("principal-identity", {
          createdAt: "2026-07-28T00:00:00.000Z",
          id: "01ARZ3NDEKTSV4RRFFQ69G5FD9" as typeof ADA,
          issuer: "https://acme.okta.com",
          organizationId: ORGANIZATION,
          principalId: ADA,
          subject: "okta|ada",
          updatedAt: "2026-07-28T00:00:00.000Z",
          version: 1,
        }),
        "2026-07-28T00:00:00.000Z",
      ),
    );

    expect((await h.application.account.profile(ADA)).emailChange).toEqual({
      kind: "managed",
      managedBy: "identity-provider",
      organizationId: ORGANIZATION,
      organizationName: "Acme",
    });
    expect(await refusal(h.application.account.requestEmailChange(request()))).toMatchObject({
      message: "Acme manages your email address. Ask its administrators to change it.",
      status: 409,
    });
  });
});

describe("confirming an email change", () => {
  test("swaps the claim, ends every session, and tells the old address how to report it", async () => {
    const h = await accountLifecycleHarness();
    const signedIn = await h.application.signIn({ email: ADA_EMAIL, password: PASSWORD });
    if (signedIn.kind !== "signed-in") throw new Error("expected a session");
    await h.application.account.requestEmailChange(request());

    expect(
      await h.application.account.confirmEmailChange({
        token: await h.lastToken("email-change-verify"),
      }),
    ).toEqual({ email: NEW_EMAIL });

    expect({
      newOwner: await h.ownerOf(NEW_EMAIL),
      oldOwner: await h.ownerOf(ADA_EMAIL),
      session: await h.application.session(signedIn.sessionToken),
    }).toEqual({ newOwner: ADA, oldOwner: undefined, session: undefined });
    const notice = (await h.deliveries()).at(-1);
    expect(notice).toMatchObject({ purpose: "email-changed", recipient: ADA_EMAIL });
    expect((await h.application.signIn({ email: NEW_EMAIL, password: PASSWORD })).kind).toBe(
      "signed-in",
    );
    expect(
      await refusal(h.application.signIn({ email: ADA_EMAIL, password: PASSWORD })),
    ).toBeDefined();
    expect((await h.application.account.profile(ADA)).emailChange).toEqual({
      kind: "held",
      reason: "changed",
      until: "2026-08-04T01:00:00.000Z",
    });
  });

  test("a link is single use and a forged one is refused", async () => {
    const h = await accountLifecycleHarness();
    await h.application.account.requestEmailChange(request());
    const token = await h.lastToken("email-change-verify");

    for (const forged of [`${ADA}.wrong`, `${GRACE}.${token.split(".")[1]}`, "nonsense"]) {
      expect(
        await refusal(h.application.account.confirmEmailChange({ token: forged })),
      ).toMatchObject({ code: "invalid_grant" });
    }
    await h.application.account.confirmEmailChange({ token });
    expect(await refusal(h.application.account.confirmEmailChange({ token }))).toMatchObject({
      code: "invalid_grant",
    });
  });

  test("when someone else claimed the address after the request, the change is refused", async () => {
    const h = await accountLifecycleHarness();
    await h.application.account.requestEmailChange({ ...request(), principalId: GRACE });
    await h.application.account.requestEmailChange(request());
    const graceToken = (await h.deliveries()).find((delivery) =>
      delivery.token?.startsWith(GRACE),
    )!.token!;
    await h.application.account.confirmEmailChange({ token: graceToken });

    expect(
      await refusal(
        h.application.account.confirmEmailChange({
          token: await h.lastToken("email-change-verify"),
        }),
      ),
    ).toMatchObject({ message: "Another account took that email address first.", status: 409 });
    expect({ ada: await h.ownerOf(ADA_EMAIL), shared: await h.ownerOf(NEW_EMAIL) }).toEqual({
      ada: ADA,
      shared: GRACE,
    });
  });

  test("two confirmations racing for one address: exactly one person gets it", async () => {
    const h = await accountLifecycleHarness();
    await h.application.account.requestEmailChange({ ...request(), principalId: GRACE });
    await h.application.account.requestEmailChange(request());
    const tokens = (await h.deliveries()).map((delivery) => delivery.token!);

    const outcomes = await Promise.all(
      tokens.map((token) =>
        h.application.account.confirmEmailChange({ token }).then(
          () => "applied",
          (error: { status?: number }) => `refused ${error.status}`,
        ),
      ),
    );

    expect(outcomes.toSorted((a, b) => a.localeCompare(b))).toEqual(["applied", "refused 409"]);
    const winner = outcomes[0] === "applied" ? GRACE : ADA;
    expect(await h.ownerOf(NEW_EMAIL)).toBe(winner);
    expect(await h.ownerOf(winner === ADA ? GRACE_EMAIL : ADA_EMAIL)).toBe(
      winner === ADA ? GRACE : ADA,
    );
  });
});

describe("reporting an email change from the old address", () => {
  async function applied() {
    const h = await accountLifecycleHarness();
    await h.application.account.requestEmailChange(request());
    await h.application.account.confirmEmailChange({
      token: await h.lastToken("email-change-verify"),
    });
    return h;
  }

  test("restores the old address, signs everyone out, and cannot be used twice", async () => {
    const h = await applied();
    const signedIn = await h.application.signIn({ email: NEW_EMAIL, password: PASSWORD });
    if (signedIn.kind !== "signed-in") throw new Error("expected a session");
    const token = await h.lastToken("email-changed");

    expect(await h.application.account.reportEmailChange({ token })).toEqual({
      emailRestored: true,
    });
    expect({
      newOwner: await h.ownerOf(NEW_EMAIL),
      oldOwner: await h.ownerOf(ADA_EMAIL),
      session: await h.application.session(signedIn.sessionToken),
    }).toEqual({ newOwner: undefined, oldOwner: ADA, session: undefined });
    expect(await refusal(h.application.account.reportEmailChange({ token }))).toMatchObject({
      code: "invalid_grant",
    });
  });

  test("when the old address was taken meanwhile, still signs everyone out", async () => {
    const h = await applied();
    await h.application.account.requestEmailChange({
      ...request(),
      newEmail: ADA_EMAIL,
      principalId: GRACE,
    });
    await h.application.account.confirmEmailChange({
      token: await h.lastToken("email-change-verify"),
    });
    const signedIn = await h.application.signIn({ email: NEW_EMAIL, password: PASSWORD });
    if (signedIn.kind !== "signed-in") throw new Error("expected a session");

    expect(
      await h.application.account.reportEmailChange({ token: (await h.deliveries())[1]!.token! }),
    ).toEqual({ emailRestored: false });
    expect({
      ada: await h.ownerOf(NEW_EMAIL),
      grace: await h.ownerOf(ADA_EMAIL),
      session: await h.application.session(signedIn.sessionToken),
    }).toEqual({ ada: ADA, grace: GRACE, session: undefined });
  });

  test("locks out whoever knew the password until a reset reaches the restored address", async () => {
    const h = await applied();
    await h.application.forgotPassword(NEW_EMAIL);
    const resetBeforeReport = await h.lastToken("reset-password");

    await h.application.account.reportEmailChange({ token: await h.lastToken("email-changed") });

    expect({
      oldPassword: await refusal(h.application.signIn({ email: ADA_EMAIL, password: PASSWORD })),
      resetBeforeReport: await refusal(
        h.application.resetPassword({
          password: "an attacker's new passphrase",
          token: resetBeforeReport,
        }),
      ),
    }).toMatchObject({
      oldPassword: { code: "access_denied" },
      resetBeforeReport: { code: "invalid_grant" },
    });
    expect((await h.deliveries()).at(-1)).toMatchObject({
      purpose: "email-change-reported",
      recipient: NEW_EMAIL,
    });
    await h.application.forgotPassword(ADA_EMAIL);
    expect((await h.deliveries()).at(-1)).toMatchObject({
      purpose: "reset-password",
      recipient: ADA_EMAIL,
    });
    await h.application.resetPassword({
      password: "ada's fresh long passphrase",
      token: await h.lastToken("reset-password"),
    });
    expect(
      (await h.application.signIn({ email: ADA_EMAIL, password: "ada's fresh long passphrase" }))
        .kind,
    ).toBe("signed-in");
  });

  test("holds new email changes for seven days after a report", async () => {
    const h = await applied();
    await h.application.account.reportEmailChange({ token: await h.lastToken("email-changed") });
    const fresh = { ...request(), newEmail: "ada@another.example" };

    expect((await h.application.account.profile(ADA)).emailChange).toEqual({
      kind: "held",
      reason: "reported",
      until: "2026-08-04T01:00:00.000Z",
    });
    expect(await refusal(h.application.account.requestEmailChange(fresh))).toMatchObject({
      status: 409,
    });
    h.advance(7 * 24 * 60 * 60);
    expect((await h.application.account.profile(ADA)).emailChange).toEqual({ kind: "available" });
  });

  test("the report window closes after seven days", async () => {
    const h = await applied();
    h.advance(7 * 24 * 60 * 60);

    expect(
      await refusal(
        h.application.account.reportEmailChange({ token: await h.lastToken("email-changed") }),
      ),
    ).toMatchObject({ code: "invalid_grant" });
    expect((await h.application.account.profile(ADA)).emailChange).toEqual({ kind: "available" });
  });
});
