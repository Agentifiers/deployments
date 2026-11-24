import type { AppHost, AppPersistence, AppRecord, AppReturnPath } from "@deployments-ai/db";
import { randomToken, sha256, sha256Base64Url, type RandomSource } from "@deployments-ai/identity";
import { readCookie, serializeBffCookie } from "@deployments-ai/web-bff-auth";
import { SESSION_COOKIE, sessionIdOf } from "./admission.ts";
import { hostOrigin, hostStatus, type HostStatus } from "./hosts.ts";
import type { GatewayLookups, SessionEpoch } from "./lookups.ts";
import type { PlatformSignIn, PlatformSignInRefusal } from "./platform-identity.ts";
import { platformPage, redirect, type Handled } from "./responses.ts";
import type { CallbackQuery } from "./routes.ts";

export const LOGIN_BINDING_COOKIE = "__Host-deployments-app-login";
const LOGIN_LIFETIME_SECONDS = 10 * 60;
const HANDOFF_LIFETIME_SECONDS = 60;
export const SESSION_LIFETIME_SECONDS = 8 * 60 * 60;

const SIGN_IN_FAILURE_STATUS: Readonly<Record<PlatformSignInRefusal, number>> = {
  "issuer-mismatch": 400,
  "token-exchange-failed": 502,
  "token-response-invalid": 502,
};

export interface SignInContext {
  readonly apps: Pick<
    AppPersistence,
    "beginLogin" | "consumeLogin" | "domainForHostname" | "issueLoginHandoff" | "redeemLoginHandoff"
  >;
  readonly appsDomain: string;
  readonly currentSessionEpoch: SessionEpoch;
  readonly identity: PlatformSignIn;
  readonly lookups: Pick<GatewayLookups, "app">;
  readonly now: () => Date;
  readonly random: RandomSource;
}

export function loginPath(returnTo: AppReturnPath | "/") {
  return `/_platform/auth/login?return_to=${encodeURIComponent(returnTo)}`;
}

function failed(input: {
  readonly link?: { readonly href: string; readonly label: string };
  readonly message: string;
  readonly reason: string;
  readonly status: number;
}): Handled {
  return {
    reason: input.reason,
    response: platformPage({
      ...(input.link ? { link: input.link } : {}),
      message: input.message,
      status: input.status,
      title: "Sign-in did not finish",
    }),
  };
}

export async function beginLogin(
  context: SignInContext,
  input: {
    readonly app: AppRecord;
    readonly host: AppHost;
    readonly returnTo: AppReturnPath;
    readonly status: Exclude<HostStatus, "not-served">;
  },
): Promise<Handled> {
  const { app, host, returnTo } = input;
  if (input.status === "sign-in-on-slug-host") {
    const slugLogin = `${hostOrigin(context.appsDomain, app, { kind: "slug" })}${loginPath(returnTo)}`;
    return { reason: "sign-in-on-slug-host", response: redirect(302, slugLogin) };
  }
  const state = randomToken(context.random);
  const nonce = randomToken(context.random);
  const codeVerifier = randomToken(context.random);
  const binding = randomToken(context.random);
  const location = await context.identity.authorizationUrl({
    codeChallenge: sha256Base64Url(codeVerifier),
    nonce,
    organizationHint: app.data.organizationId,
    state,
  });
  await context.apps.beginLogin({
    appId: app.data.id,
    bindingHash: sha256(binding),
    codeVerifier,
    expiresAt: new Date(context.now().getTime() + LOGIN_LIFETIME_SECONDS * 1_000),
    host,
    nonceHash: sha256(nonce),
    returnTo,
    stateHash: sha256(state),
  });
  return {
    response: redirect(302, location, [
      serializeBffCookie(LOGIN_BINDING_COOKIE, binding, LOGIN_LIFETIME_SECONDS),
    ]),
  };
}

export async function completeCallback(
  context: SignInContext,
  query: CallbackQuery,
): Promise<Handled> {
  const login = query.state
    ? await context.apps.consumeLogin({ stateHash: sha256(query.state) })
    : undefined;
  if (!login) {
    return failed({
      message: "This sign-in expired or was already used. Go back to the app and sign in again.",
      reason: "unknown-login",
      status: 400,
    });
  }
  const app = await context.lookups.app(login.data.appId);
  if (app?.data.lifecycle.state !== "active") {
    return failed({
      message: "This app is not available.",
      reason: "app-unavailable",
      status: 404,
    });
  }
  const { host, returnTo } = login.data;
  const fresh = { domain: context.apps.domainForHostname };
  if ((await hostStatus(fresh, app.data.id, host)) !== "sign-in-here") {
    return failed({
      link: {
        href: `${hostOrigin(context.appsDomain, app, { kind: "slug" })}${loginPath(returnTo)}`,
        label: "Sign in on the app's own address",
      },
      message: "This address no longer offers sign-in for the app.",
      reason: "host-not-signable",
      status: 403,
    });
  }
  const appOrigin = hostOrigin(context.appsDomain, app, host);
  const retry = { href: `${appOrigin}${loginPath(returnTo)}`, label: "Sign in again" };
  if (query.error !== null || !query.code) {
    return failed({
      link: retry,
      message: "The platform did not complete the sign-in.",
      reason: "authorization-error",
      status: 400,
    });
  }
  const redeemed = await context.identity.redeemCode({
    code: query.code,
    codeVerifier: login.data.codeVerifier,
    iss: query.iss,
    nonceHash: login.data.nonceHash,
  });
  if (redeemed.kind === "refused") {
    return failed({
      link: retry,
      message: "The platform's answer could not be verified.",
      reason: redeemed.reason,
      status: SIGN_IN_FAILURE_STATUS[redeemed.reason],
    });
  }
  const { identity } = redeemed;
  const sessionEpoch = await context.currentSessionEpoch(identity.principalId);
  if (sessionEpoch === undefined) {
    return failed({
      message: "Your platform account cannot sign in.",
      reason: "no-security-state",
      status: 403,
    });
  }
  const handoff = randomToken(context.random);
  await context.apps.issueLoginHandoff({
    expiresAt: new Date(context.now().getTime() + HANDOFF_LIFETIME_SECONDS * 1_000),
    handoffHash: sha256(handoff),
    login,
    subject: { kind: "member", ...identity, sessionEpoch },
  });
  return {
    response: redirect(
      303,
      `${appOrigin}/_platform/auth/complete?handoff=${encodeURIComponent(handoff)}`,
    ),
  };
}

export async function completeLogin(
  context: SignInContext,
  input: {
    readonly app: AppRecord;
    readonly handoff: string;
    readonly host: AppHost;
    readonly request: Request;
    readonly status: Exclude<HostStatus, "not-served">;
  },
): Promise<Handled> {
  const { app, handoff } = input;
  const binding = readCookie(input.request.headers.get("cookie"), LOGIN_BINDING_COOKIE);
  const refuse = (reason: string) =>
    failed({
      link: { href: loginPath("/"), label: "Sign in again" },
      message: "Sign-in must finish in the browser and on the address that started it.",
      reason,
      status: 403,
    });
  if (input.status !== "sign-in-here") return refuse("host-not-signable");
  if (binding === undefined) return refuse("missing-binding");
  if (!handoff) return refuse("missing-handoff");
  const sessionToken = randomToken(context.random);
  const redemption = await context.apps.redeemLoginHandoff({
    appId: app.data.id,
    bindingHash: sha256(binding),
    handoffHash: sha256(handoff),
    host: input.host,
    session: {
      expiresAt: new Date(context.now().getTime() + SESSION_LIFETIME_SECONDS * 1_000),
      sessionId: sessionIdOf(sessionToken),
    },
  });
  if (redemption.kind === "rejected") return refuse(redemption.reason);
  return {
    response: redirect(303, redemption.returnTo, [
      serializeBffCookie(SESSION_COOKIE, sessionToken, SESSION_LIFETIME_SECONDS),
      serializeBffCookie(LOGIN_BINDING_COOKIE, "", 0),
    ]),
  };
}
