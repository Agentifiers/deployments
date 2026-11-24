import "@tanstack/react-start/server-only";
import type { ConnectionView } from "../connections/connection-state.ts";
import type { OAuthAppView } from "../connections/oauth.ts";
import type { EnvironmentScope } from "../scope.ts";
import { consoleConfig } from "./config.ts";
import { walkConnections } from "./connection-data.ts";
import { API_PAGE_LIMIT } from "./list-pages.ts";
import { callRoute, collectPages } from "./platform-api.ts";

export type AppConnection = Pick<ConnectionView, "displayName" | "id" | "providerApplicationId">;

export interface OAuthApps {
  readonly apps: readonly OAuthAppView[];
  /** Live connections that refresh through an app, which fail once it is archived. */
  readonly appConnections: readonly AppConnection[];
  /** False when the environment has more connections than the console reads. */
  readonly complete: boolean;
  /** Origin of the platform's OAuth callback; unset when this console was not given it. */
  readonly callbackOrigin?: string;
}

export async function loadOAuthApps(
  accessToken: string,
  scope: EnvironmentScope,
): Promise<OAuthApps> {
  const [apps, connections] = await Promise.all([
    collectPages((cursor) =>
      callRoute(
        "listProviderApplications",
        { query: { cursor, limit: API_PAGE_LIMIT }, scope },
        accessToken,
      ),
    ),
    walkConnections(accessToken, scope),
  ]);
  const latest = new Map<string, ConnectionView>();
  for (const connection of connections.items) {
    const seen = latest.get(connection.id);
    if (!seen || seen.version < connection.version) latest.set(connection.id, connection);
  }
  const { oauthCallbackOrigin } = consoleConfig();
  return {
    appConnections: [...latest.values()]
      .filter(
        (connection) => connection.providerApplicationId && connection.status !== "disconnected",
      )
      .map(({ displayName, id, providerApplicationId }) => ({
        displayName,
        id,
        providerApplicationId,
      })),
    apps: apps.toSorted(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id),
    ),
    complete: connections.complete,
    ...(oauthCallbackOrigin ? { callbackOrigin: oauthCallbackOrigin } : {}),
  };
}
