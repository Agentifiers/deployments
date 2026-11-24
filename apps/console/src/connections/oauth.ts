import type { ProviderApplicationResponse } from "@deployments-ai/api-contract/providers";
import type { OperationAccess } from "../access.ts";
import { oneOf } from "../observability/range.ts";
import { environmentPath, type EnvironmentScope } from "../scope.ts";
import type { ConnectionView, ProviderOAuthEntry } from "./connection-state.ts";
import type { RebindSelections } from "./rebind.ts";

export type OAuthAppView = typeof ProviderApplicationResponse.Type;
export type OAuthAppAction = "rotate" | "archive";

/** The only failures the provider callback reports; provider error text never reaches the browser. */
export const OAUTH_CALLBACK_ERRORS = ["access_denied", "authorization_failed"] as const;
export type OAuthCallbackError = (typeof OAUTH_CALLBACK_ERRORS)[number];

/**
 * Whether to authorize the new connection before or after revoking the old one. The provider
 * refuses to link an account a live connection already holds, so a reauthorization with the
 * same account must revoke first; `choose` leaves that to the operator, who knows the account.
 */
export type AuthorizationOrder =
  | { readonly kind: "authorize-first" }
  | { readonly kind: "revoke-first" }
  | { readonly kind: "choose" }
  | { readonly kind: "wait"; readonly until: string };

/**
 * Where the provider callback sends the browser back to. A rebind return carries the choices the
 * operator made before leaving for the consent page.
 */
export type ReturnTarget =
  | { readonly kind: "connect" }
  | ({
      readonly kind: "rebind";
      readonly oldConnectionId: string;
      readonly since: string;
    } & RebindSelections);

/**
 * The OAuth app an authorization uses. With one active app for the provider, the platform uses
 * it, and with several the operator picks one. With none, the platform registers its own client,
 * unless the provider accepts only clients registered with it.
 */
export type AppChoice =
  | {
      readonly kind: "chosen";
      readonly app: OAuthAppView;
      readonly active: readonly OAuthAppView[];
    }
  | { readonly kind: "choose"; readonly active: readonly OAuthAppView[] }
  | { readonly kind: "platform" }
  | { readonly kind: "missing" };

export type CallbackResult =
  | { readonly kind: "connected"; readonly connectionId: string }
  | { readonly kind: "failed"; readonly error: OAuthCallbackError }
  | { readonly kind: "none" };

/** What the provider callback appended to the console's return URL. */
export interface ConnectReturn {
  readonly result: CallbackResult;
  readonly rebind?: { readonly oldConnectionId: string; readonly since?: string };
}

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const CALLBACK_PATH = "/public/provider-connections/oauth/callback/";
/**
 * A platform OAuth refresh passes through `reauthorization-required` between two commits, so a
 * connection that entered it this recently may be active again in a moment.
 */
const REFRESH_SETTLE_MS = 120_000;

export function appActions(
  app: Pick<OAuthAppView, "hasClientSecret" | "status">,
  access: Pick<OperationAccess, "archiveProviderApplication" | "rotateProviderApplicationSecret">,
): readonly OAuthAppAction[] {
  if (app.status === "archived") return [];
  const rotate = access.rotateProviderApplicationSecret && app.status === "active";
  return [
    ...(rotate && app.hasClientSecret ? (["rotate"] as const) : []),
    ...(access.archiveProviderApplication ? (["archive"] as const) : []),
  ];
}

export function appChoice(
  apps: readonly OAuthAppView[],
  provider: { readonly key: string; readonly requiresApp: boolean },
  picked: string | undefined,
): AppChoice {
  const active = apps.filter((app) => app.providerKey === provider.key && app.status === "active");
  const app =
    active.find((candidate) => candidate.id === picked) ??
    (active.length === 1 ? active[0] : undefined);
  if (app) return { active, app, kind: "chosen" };
  if (active.length > 1) return { active, kind: "choose" };
  return { kind: provider.requiresApp ? "missing" : "platform" };
}

/**
 * Whether a second connection could claim the same provider account. Vendor MCP connections
 * without an account claim get `mcp:<attempt>`, and verify stores the connection ID when the
 * provider names no account; neither is ever shared.
 */
export function identityCanCollide(
  connection: Pick<ConnectionView, "externalAccountId" | "id">,
): boolean {
  const account = connection.externalAccountId;
  return (
    account !== undefined &&
    account !== "" &&
    !account.startsWith("mcp:") &&
    account !== connection.id
  );
}

/** The runtime already denies every connection that is not active. */
export function authorizationOrder(old: ConnectionView, now: string): AuthorizationOrder {
  if (old.status === "disconnected" || !identityCanCollide(old)) return { kind: "authorize-first" };
  if (old.status === "active") return { kind: "choose" };
  const settled = Date.parse(old.updatedAt) + REFRESH_SETTLE_MS;
  if (old.status === "reauthorization-required" && Date.parse(now) < settled) {
    return { kind: "wait", until: new Date(settled).toISOString() };
  }
  return { kind: "revoke-first" };
}

/**
 * The redirect URI to register with the provider. Without the channel API origin the console
 * can show only the path, with a placeholder the operator replaces.
 */
export function oauthCallbackUri(
  origin: string | undefined,
  oauth: Pick<ProviderOAuthEntry, "callbackKey">,
): { readonly uri: string; readonly complete: boolean } {
  return {
    complete: origin !== undefined,
    uri: `${origin ?? "<channel API origin>"}${CALLBACK_PATH}${oauth.callbackKey}`,
  };
}

/** The console page the provider callback returns to; the console server builds it. */
export function returnToUrl(
  publicOrigin: string,
  scope: EnvironmentScope,
  target: ReturnTarget,
): string {
  const url = new URL(`${environmentPath(scope)}/connections/authorized`, publicOrigin);
  if (target.kind === "rebind") {
    url.searchParams.set("rebind", target.oldConnectionId);
    url.searchParams.set("since", target.since);
    for (const name of ["include", "skip", "skipDeployments"] as const) {
      const list = target[name];
      // The router reads a search value that parses as JSON as that value, so a list survives.
      if (list && list.length > 0) url.searchParams.set(name, JSON.stringify(list));
    }
  }
  return url.href;
}

export function parseConnectReturn(search: Readonly<Record<string, unknown>>): ConnectReturn {
  const { connection_id: connectionId, rebind, since } = search;
  const error = oneOf(OAUTH_CALLBACK_ERRORS, search.error);
  const result: CallbackResult =
    typeof connectionId === "string" && ULID.test(connectionId)
      ? { connectionId, kind: "connected" }
      : error
        ? { error, kind: "failed" }
        : { kind: "none" };
  if (typeof rebind !== "string" || !ULID.test(rebind)) return { result };
  const validSince = typeof since === "string" && Number.isFinite(Date.parse(since));
  return {
    rebind: {
      oldConnectionId: rebind,
      ...(validSince ? { since: new Date(since).toISOString() } : {}),
    },
    result,
  };
}
