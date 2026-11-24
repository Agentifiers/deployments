import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { AppHostname } from "../records/app-domains.ts";
import {
  AppLoginHandoffRecord,
  AppLoginTransactionRecord,
  AppReturnPath,
  AppSessionId,
  AppSessionRecord,
  type AppHost,
} from "../records/apps.ts";
import type { AppSessionPersistence } from "./sessions.ts";
import { appHarness, id, MEMBER, RUN } from "./test-support.ts";

const APP = id("01ARZ3NDEKTSV4RRFFQ69G5FC0");
const OTHER_APP = id("01ARZ3NDEKTSV4RRFFQ69G5FC1");
const TOKEN_SESSION = id("01ARZ3NDEKTSV4RRFFQ69G5FC2");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenHash = (token: string) => Schema.decodeUnknownSync(AppSessionId)(hash(token));
const MEMBER_SUBJECT = {
  email: "member@example.com",
  kind: "member",
  principalId: MEMBER,
  sessionEpoch: 3,
  tokenSessionId: TOKEN_SESSION,
} as const;
const RETURN_TO = Schema.decodeUnknownSync(AppReturnPath)("/orders?status=open");
const CUSTOM_HOST = {
  hostname: Schema.decodeUnknownSync(AppHostname)("rsvp.example.com"),
  kind: "custom",
} as const;

function beginLogin(apps: AppSessionPersistence, state = "state") {
  return apps.beginLogin({
    appId: APP,
    bindingHash: hash("browser-binding"),
    codeVerifier: "verifier",
    expiresAt: new Date("2026-10-08T12:10:00.000Z"),
    host: CUSTOM_HOST,
    nonceHash: hash("nonce"),
    returnTo: RETURN_TO,
    stateHash: hash(state),
  });
}

async function consumedLogin(apps: AppSessionPersistence) {
  await beginLogin(apps);
  const login = await apps.consumeLogin({ stateHash: hash("state") });
  if (!login) throw new Error("The login transaction was not consumed.");
  return login;
}

describe("app sessions", () => {
  test("a session is found by its token hash alone until it expires", async () => {
    const { advance, apps } = appHarness();
    const sessionId = tokenHash("opaque-session-token");

    const created = await apps.createSession({
      appId: APP,
      expiresAt: new Date("2026-10-08T20:00:00.000Z"),
      sessionId,
      subject: MEMBER_SUBJECT,
    });

    expect(created.pk).toBe(`APP-SESSION#${sessionId}`);
    expect(created.ttl).toBe(1_791_489_600);
    expect((await apps.getSession({ sessionId }))?.data).toEqual({
      appId: APP,
      createdAt: "2026-10-08T12:00:00.000Z",
      expiresAt: "2026-10-08T20:00:00.000Z",
      host: { kind: "slug" },
      id: sessionId,
      subject: MEMBER_SUBJECT,
    });
    expect(await apps.getSession({ sessionId: tokenHash("another-token") })).toBeUndefined();

    advance(8 * 60 * 60 * 1_000 - 1);
    expect((await apps.getSession({ sessionId }))?.data.id).toBe(sessionId);
    advance(1);
    expect(await apps.getSession({ sessionId })).toBeUndefined();
  });

  test("an agent dev session carries its run and role, and logout deletes it", async () => {
    const { apps } = appHarness();
    const sessionId = tokenHash("dev-token");
    await apps.createSession({
      appId: APP,
      expiresAt: new Date("2026-10-08T13:00:00.000Z"),
      sessionId,
      subject: { kind: "agent-dev", role: "editor", runId: RUN },
    });

    expect((await apps.getSession({ sessionId }))?.data.subject).toEqual({
      kind: "agent-dev",
      role: "editor",
      runId: RUN,
    });

    await apps.deleteSession({ sessionId });
    await apps.deleteSession({ sessionId });

    expect(await apps.getSession({ sessionId })).toBeUndefined();
  });

  test("a session stored before sessions recorded a host decodes as issued on the slug host", async () => {
    const { apps } = appHarness();
    const created = await apps.createSession({
      appId: APP,
      expiresAt: new Date("2026-10-08T20:00:00.000Z"),
      sessionId: tokenHash("legacy-session"),
      subject: MEMBER_SUBJECT,
    });
    const { host, ...legacy } = Schema.encodeSync(AppSessionRecord)(created).data;

    expect({
      decoded: Schema.decodeUnknownSync(AppSessionRecord)({ ...created, data: legacy }).data.host,
      stored: host,
    }).toEqual({ decoded: { kind: "slug" }, stored: { kind: "slug" } });
  });
});

describe("app sign-in", () => {
  test("a login transaction is consumed once and never after it expires", async () => {
    const { advance, apps } = appHarness();
    await beginLogin(apps, "first");
    await beginLogin(apps, "second");

    const consumed = await apps.consumeLogin({ stateHash: hash("first") });

    expect(consumed?.data).toEqual({
      appId: APP,
      bindingHash: hash("browser-binding"),
      codeVerifier: "verifier",
      createdAt: "2026-10-08T12:00:00.000Z",
      expiresAt: "2026-10-08T12:10:00.000Z",
      host: CUSTOM_HOST,
      id: hash("first"),
      nonceHash: hash("nonce"),
      returnTo: RETURN_TO,
    });
    expect(await apps.consumeLogin({ stateHash: hash("first") })).toBeUndefined();
    advance(10 * 60 * 1_000);
    expect(await apps.consumeLogin({ stateHash: hash("second") })).toBeUndefined();
  });

  test("a handoff opened in another browser, app or host stays redeemable by its own browser once", async () => {
    const { advance, apps } = appHarness();
    const login = await consumedLogin(apps);
    await apps.issueLoginHandoff({
      expiresAt: new Date("2026-10-08T12:01:00.000Z"),
      handoffHash: hash("handoff"),
      login,
      subject: MEMBER_SUBJECT,
    });
    const redeem = (
      appId: typeof APP,
      binding: string,
      sessionToken: string,
      host: AppHost = CUSTOM_HOST,
    ) =>
      apps.redeemLoginHandoff({
        appId,
        bindingHash: hash(binding),
        handoffHash: hash("handoff"),
        host,
        session: {
          expiresAt: new Date("2026-10-08T20:00:00.000Z"),
          sessionId: tokenHash(sessionToken),
        },
      });

    expect(await redeem(APP, "attacker-binding", "attacker-session")).toEqual({
      kind: "rejected",
      reason: "other-browser",
    });
    expect(await redeem(OTHER_APP, "browser-binding", "other-app-session")).toEqual({
      kind: "rejected",
      reason: "other-app",
    });
    expect(await redeem(APP, "browser-binding", "slug-session", { kind: "slug" })).toEqual({
      kind: "rejected",
      reason: "other-host",
    });
    advance(59_999);
    const redeemed = await redeem(APP, "browser-binding", "member-session");
    expect(redeemed.kind === "redeemed" ? redeemed.session.data : redeemed).toEqual({
      appId: APP,
      createdAt: "2026-10-08T12:00:59.999Z",
      expiresAt: "2026-10-08T20:00:00.000Z",
      host: CUSTOM_HOST,
      id: tokenHash("member-session"),
      subject: MEMBER_SUBJECT,
    });
    expect(await apps.getSession({ sessionId: tokenHash("member-session") })).toEqual(
      redeemed.kind === "redeemed" ? redeemed.session : undefined,
    );
    expect(redeemed.kind === "redeemed" ? redeemed.returnTo : redeemed).toBe(RETURN_TO);
    expect(await redeem(APP, "browser-binding", "replayed-session")).toEqual({
      kind: "rejected",
      reason: "missing",
    });
    expect(await apps.getSession({ sessionId: tokenHash("attacker-session") })).toBeUndefined();
  });

  test("an expired handoff is refused", async () => {
    const { advance, apps } = appHarness();
    await apps.issueLoginHandoff({
      expiresAt: new Date("2026-10-08T12:01:00.000Z"),
      handoffHash: hash("handoff"),
      login: await consumedLogin(apps),
      subject: MEMBER_SUBJECT,
    });
    advance(60_000);

    expect(
      await apps.redeemLoginHandoff({
        appId: APP,
        bindingHash: hash("browser-binding"),
        handoffHash: hash("handoff"),
        host: CUSTOM_HOST,
        session: {
          expiresAt: new Date("2026-10-08T20:00:00.000Z"),
          sessionId: tokenHash("member-session"),
        },
      }),
    ).toEqual({ kind: "rejected", reason: "expired" });
  });

  test("a login and a handoff stored before logins recorded a host decode as started on the slug host", async () => {
    const { apps } = appHarness();
    const login = await consumedLogin(apps);
    const handoff = await apps.issueLoginHandoff({
      expiresAt: new Date("2026-10-08T12:01:00.000Z"),
      handoffHash: hash("handoff"),
      login,
      subject: MEMBER_SUBJECT,
    });
    const { host: _loginHost, ...legacyLogin } =
      Schema.encodeSync(AppLoginTransactionRecord)(login).data;
    const { host: handoffHost, ...legacyHandoff } =
      Schema.encodeSync(AppLoginHandoffRecord)(handoff).data;

    expect({
      handoff: Schema.decodeUnknownSync(AppLoginHandoffRecord)({ ...handoff, data: legacyHandoff })
        .data.host,
      login: Schema.decodeUnknownSync(AppLoginTransactionRecord)({ ...login, data: legacyLogin })
        .data.host,
      stored: handoffHost,
    }).toEqual({ handoff: { kind: "slug" }, login: { kind: "slug" }, stored: CUSTOM_HOST });
  });
});
