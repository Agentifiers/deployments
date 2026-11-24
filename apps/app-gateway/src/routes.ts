import { AppHost, AppReturnPath, Ulid } from "@deployments-ai/db";
import { Schema } from "effect";

export const APP_ID_HEADER = "x-deployments-app-id";
export const APP_HOST_HEADER = "x-deployments-app-host";

export type AppRoute =
  | { readonly kind: "api"; readonly functionName: string }
  | { readonly kind: "complete"; readonly handoff: string }
  | { readonly kind: "login"; readonly returnTo: AppReturnPath }
  | { readonly kind: "logout" }
  | { readonly kind: "me" }
  | {
      readonly kind: "page";
      readonly path: AppReturnPath;
      readonly pathname: string;
      readonly search: string;
    };

export interface CallbackQuery {
  readonly code: string | null;
  readonly error: string | null;
  readonly iss: string | null;
  readonly state: string | null;
}

interface Rejected {
  readonly kind: "rejected";
  readonly status: 404 | 405;
}

export type GatewayRequest =
  | { readonly kind: "health" }
  | { readonly kind: "callback"; readonly query: CallbackQuery }
  | {
      readonly appId: Ulid;
      readonly host: AppHost;
      readonly kind: "app";
      readonly route: AppRoute;
    }
  | Rejected;

const NOT_FOUND: Rejected = { kind: "rejected", status: 404 };
const METHOD_NOT_ALLOWED: Rejected = { kind: "rejected", status: 405 };
const API_PREFIX = "/_platform/api/";
const FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const PLATFORM_PATH = /^\/_platform(?:\/|$)/u;
const PLACEHOLDER_ORIGIN = "https://app.invalid";
const ROOT = Schema.decodeUnknownSync(AppReturnPath)("/");

export function returnPath(raw: string | null): AppReturnPath {
  if (raw === null || !raw.startsWith("/")) return ROOT;
  const parsed = URL.parse(raw, PLACEHOLDER_ORIGIN);
  if (parsed?.origin !== PLACEHOLDER_ORIGIN || PLATFORM_PATH.test(parsed.pathname)) return ROOT;
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  return Schema.is(AppReturnPath)(path) ? path : ROOT;
}

function appRoute(method: string, url: URL): AppRoute | Rejected {
  const only = (allowed: "GET" | "POST", route: AppRoute) =>
    method === allowed ? route : METHOD_NOT_ALLOWED;
  const { pathname, searchParams } = url;
  switch (pathname) {
    case "/_platform/auth/login":
      return only("GET", { kind: "login", returnTo: returnPath(searchParams.get("return_to")) });
    case "/_platform/auth/complete":
      return only("GET", { handoff: searchParams.get("handoff") ?? "", kind: "complete" });
    case "/_platform/auth/logout":
      return only("POST", { kind: "logout" });
    case "/_platform/me":
      return only("GET", { kind: "me" });
  }
  if (pathname.startsWith(API_PREFIX)) {
    const functionName = pathname.slice(API_PREFIX.length);
    return FUNCTION_NAME.test(functionName)
      ? only("POST", { functionName, kind: "api" })
      : NOT_FOUND;
  }
  if (PLATFORM_PATH.test(pathname)) return NOT_FOUND;
  if (method !== "GET" && method !== "HEAD") return METHOD_NOT_ALLOWED;
  return {
    kind: "page",
    path: returnPath(`${pathname}${url.search}`),
    pathname,
    search: url.search,
  };
}

export function parseRequest(request: Request): GatewayRequest {
  const url = new URL(request.url);
  if (url.pathname === "/_platform/healthz") {
    return request.method === "GET" ? { kind: "health" } : METHOD_NOT_ALLOWED;
  }
  const appId = request.headers.get(APP_ID_HEADER);
  if (appId === null) {
    if (url.pathname !== "/_platform/auth/callback") return NOT_FOUND;
    if (request.method !== "GET") return METHOD_NOT_ALLOWED;
    const query = url.searchParams;
    return {
      kind: "callback",
      query: {
        code: query.get("code"),
        error: query.get("error"),
        iss: query.get("iss"),
        state: query.get("state"),
      },
    };
  }
  if (!Schema.is(Ulid)(appId)) return NOT_FOUND;
  const hostname = request.headers.get(APP_HOST_HEADER);
  const host =
    hostname === null ? { kind: "slug" as const } : { hostname, kind: "custom" as const };
  if (!Schema.is(AppHost)(host)) return NOT_FOUND;
  const route = appRoute(request.method, url);
  return route.kind === "rejected" ? route : { appId, host, kind: "app", route };
}
