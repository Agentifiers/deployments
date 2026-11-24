import type { AppApiGateway } from "@deployments-ai/app-database";
import {
  appIsPublic,
  type AppHost,
  type AppLifecycleState,
  type AppPersistence,
  type AppRecord,
  type Ulid,
} from "@deployments-ai/db";
import { decideActivity } from "@deployments-ai/organization-admission";
import type { RandomSource } from "@deployments-ai/identity";
import { serializeBffCookie } from "@deployments-ai/web-bff-auth";
import {
  admit,
  credentialOf,
  sessionIdOf,
  SESSION_COOKIE,
  type Admission,
  type Caller,
  type Credential,
  type RefusalReason,
} from "./admission.ts";
import { accessFor } from "./access-policy.ts";
import { callApi, crossSiteRefusal, type ApiCallLimits } from "./api-calls.ts";
import { hostStatus } from "./hosts.ts";
import type { GatewayLookups, SessionEpoch } from "./lookups.ts";
import { livePage } from "./pages.ts";
import type { PlatformSignIn } from "./platform-identity.ts";
import { RENDERED_PAGE_CACHE_BYTES, renderedPages, type ReleaseFiles } from "./rendered-pages.ts";
import {
  apiError,
  emptyResponse,
  jsonResponse,
  platformPage,
  redirect,
  type Handled,
} from "./responses.ts";
import { parseRequest, type AppRoute, type GatewayRequest } from "./routes.ts";
import { beginLogin, completeCallback, completeLogin, loginPath } from "./sign-in.ts";
import { callAsVisitor, visitorPageRefusal, type VisitorGate } from "./visitor-calls.ts";

export interface RequestLogEntry {
  readonly app: string | null;
  readonly databaseError: string | null;
  readonly durationMs: number;
  readonly function: string | null;
  readonly reason: string | null;
  readonly role: string | null;
  readonly route: string;
  readonly rows: number | null;
  readonly status: number;
}

export interface AppGatewayDependencies {
  readonly apps: Pick<
    AppPersistence,
    | "beginLogin"
    | "consumeLogin"
    | "deleteSession"
    | "domainForHostname"
    | "getSession"
    | "issueLoginHandoff"
    | "redeemLoginHandoff"
  >;
  readonly appsDomain: string;
  readonly currentSessionEpoch: SessionEpoch;
  readonly database: Pick<AppApiGateway, "callApiFunction">;
  readonly identity: PlatformSignIn;
  readonly limits: ApiCallLimits;
  readonly log: (entry: RequestLogEntry) => void;
  readonly lookups: GatewayLookups;
  readonly now: () => Date;
  readonly random: RandomSource;
  readonly releases: ReleaseFiles;
  readonly visitors: VisitorGate;
}

const UNAVAILABLE_STATUS: Readonly<Record<AppLifecycleState, 404 | 410 | null>> = {
  active: null,
  archived: 410,
  erasing: 410,
  failed: 404,
  provisioning: 404,
};

const SUSPENDED_RETRY_AFTER_SECONDS = "300";

const REFUSALS: Readonly<
  Record<RefusalReason, { readonly code: string; readonly message: string }>
> = {
  "no-role": { code: "no_access", message: "You have no access to this app." },
  "not-a-member": {
    code: "not_a_member",
    message: "You are not an active member of this app's organization.",
  },
  "other-app": { code: "other_app", message: "This session belongs to another app." },
  "other-host": { code: "other_host", message: "This session belongs to another host." },
  "sso-required": {
    code: "sso_required",
    message: "Your organization requires single sign-on. Sign in again through it.",
  },
};

function apiRefusal(admission: Exclude<Admission, { readonly kind: "admitted" }>): Handled {
  if (admission.kind === "anonymous") {
    return {
      reason: "anonymous",
      response: apiError(401, "unauthenticated", "Sign in to use this app."),
    };
  }
  const refusal = REFUSALS[admission.reason];
  return { reason: admission.reason, response: apiError(403, refusal.code, refusal.message) };
}

function unavailable(route: AppRoute, status: 404 | 410): Handled {
  const gone = status === 410;
  const message = gone ? "This app was archived." : "This app does not exist.";
  return {
    reason: gone ? "app-gone" : "app-not-found",
    response:
      route.kind === "api" || route.kind === "me"
        ? apiError(status, gone ? "app_gone" : "app_not_found", message)
        : platformPage({ message, status, title: "App unavailable" }),
  };
}

/** Says the app is down without saying why: visitors must not learn the organization's standing. */
function suspended(route: AppRoute): Handled {
  const message = "This app is temporarily unavailable. Try again later.";
  const response =
    route.kind === "api" || route.kind === "me"
      ? apiError(503, "app_unavailable", message)
      : platformPage({ message, status: 503, title: "App unavailable" });
  response.headers.set("retry-after", SUSPENDED_RETRY_AFTER_SECONDS);
  return { reason: "organization-suspended", response };
}

function me(app: AppRecord, caller: Caller) {
  return {
    app: { id: app.data.id, name: app.data.name, slug: app.data.slug },
    caller:
      caller.kind === "member"
        ? { email: caller.email, kind: "member", principalId: caller.principalId }
        : { kind: "agent-dev", runId: caller.runId },
    role: caller.role,
  };
}

export function createAppGateway(
  dependencies: AppGatewayDependencies,
): (request: Request) => Promise<Response> {
  const { apps, lookups } = dependencies;
  const pages = renderedPages({
    maxBytes: RENDERED_PAGE_CACHE_BYTES,
    releases: dependencies.releases,
  });

  async function logout(
    appId: Ulid,
    request: Request,
    credential: Credential | undefined,
  ): Promise<Handled> {
    if (credential?.kind === "cookie" && request.headers.get("sec-fetch-site") !== "same-origin") {
      return {
        reason: "cross-site",
        response: apiError(403, "cross_site_request", "Sign out from the app's own pages."),
      };
    }
    if (credential) {
      const sessionId = sessionIdOf(credential.token);
      const session = await apps.getSession({ sessionId });
      if (session?.data.appId === appId) await apps.deleteSession({ sessionId });
    }
    return { response: emptyResponse(204, [serializeBffCookie(SESSION_COOKIE, "", 0)]) };
  }

  async function appRequest(
    request: Request,
    target: { readonly appId: Ulid; readonly host: AppHost; readonly route: AppRoute },
  ): Promise<Handled> {
    const { appId, host, route } = target;
    const status = await hostStatus(lookups, appId, host);
    if (status === "not-served") return { ...unavailable(route, 404), reason: "host-not-served" };
    const presented = credentialOf(request);
    // A cookie from before an API key re-attached this host must not work, so only signable hosts read one.
    const credential =
      presented?.kind === "cookie" && status !== "sign-in-here" ? undefined : presented;
    if (route.kind === "logout") return logout(appId, request, credential);
    const app = await lookups.app(appId);
    if (app === undefined) return unavailable(route, 404);
    const gone = UNAVAILABLE_STATUS[app.data.lifecycle.state];
    if (gone !== null) return unavailable(route, gone);
    if (
      decideActivity(await lookups.standing(app.data.organizationId), "public.serve").kind !==
      "admitted"
    ) {
      return suspended(route);
    }
    if (route.kind === "login") {
      return beginLogin(dependencies, { app, host, returnTo: route.returnTo, status });
    }
    if (route.kind === "complete") {
      return completeLogin(dependencies, { app, handoff: route.handoff, host, request, status });
    }
    const crossSite =
      route.kind === "api" && credential?.kind !== "bearer"
        ? crossSiteRefusal(request, credential ? "cookie" : "visitor")
        : undefined;
    if (crossSite && credential) return crossSite;
    const admitted = await admit({ app, credential, host, lookups, sessions: apps });
    const exposure = appIsPublic(app.data) ? "public" : "members";
    switch (route.kind) {
      case "api": {
        const access = accessFor(exposure, admitted);
        const { functionName } = route;
        switch (access.kind) {
          case "caller":
            return callApi(dependencies, { app, caller: access.caller, functionName, request });
          case "visitor":
            if (crossSite) return { ...crossSite, role: "visitor" };
            return callAsVisitor(dependencies, {
              app,
              functionName,
              refusal: () => apiRefusal(access.admission),
              request,
            });
          case "anonymous":
          case "refused":
            return apiRefusal(access);
        }
      }
      case "me":
        if (admitted.kind !== "admitted") return apiRefusal(admitted);
        return {
          response: jsonResponse(200, me(app, admitted.caller)),
          role: admitted.caller.role,
        };
      case "page": {
        const access = accessFor(exposure, admitted);
        switch (access.kind) {
          case "caller":
            return livePage({ lookups, pages }, app, access.caller.role, route);
          case "visitor":
            return livePage({ lookups, pages }, app, "visitor", route, () =>
              visitorPageRefusal(dependencies.visitors, request),
            );
          case "anonymous":
            return { reason: "anonymous", response: redirect(302, loginPath(route.path)) };
          case "refused": {
            const refusal = REFUSALS[access.reason];
            return {
              reason: access.reason,
              response: platformPage({
                ...(access.reason === "sso-required"
                  ? { link: { href: loginPath(route.path), label: "Sign in again" } }
                  : {}),
                message: refusal.message,
                status: 403,
                title: "Access denied",
              }),
            };
          }
        }
      }
    }
  }

  function dispatch(parsed: GatewayRequest, request: Request): Promise<Handled> | Handled {
    switch (parsed.kind) {
      case "health":
        return { response: jsonResponse(200, { status: "ok" }) };
      case "callback":
        return completeCallback(dependencies, parsed.query);
      case "app":
        return appRequest(request, parsed);
      case "rejected":
        return {
          reason: "unrouted",
          response:
            parsed.status === 404
              ? apiError(404, "not_found", "No such route.")
              : apiError(405, "method_not_allowed", "This route does not take that method."),
        };
    }
  }

  return async (request) => {
    const started = performance.now();
    const parsed = parseRequest(request);
    let handled: Handled;
    try {
      handled = await dispatch(parsed, request);
    } catch (error) {
      handled = {
        reason:
          error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 300) : "unknown",
        response: apiError(500, "internal_error", "The gateway could not handle the request."),
      };
    }
    if (parsed.kind !== "health") {
      dependencies.log({
        app: parsed.kind === "app" ? parsed.appId : null,
        databaseError: handled.databaseError ?? null,
        durationMs: Math.round(performance.now() - started),
        function:
          parsed.kind === "app" && parsed.route.kind === "api" ? parsed.route.functionName : null,
        reason: handled.reason ?? null,
        role: handled.role ?? null,
        route: parsed.kind === "app" ? parsed.route.kind : parsed.kind,
        rows: handled.rows ?? null,
        status: handled.response.status,
      });
    }
    return handled.response;
  };
}
