import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { IntegrationEndpoints } from "../integrations/endpoints.ts";
import { consoleConfig } from "../server/config.ts";
import { requireAccessToken } from "../server/session.ts";

/** Signed in only: the origins are not secret, but the console shows nothing to anonymous callers. */
const fetchIntegrationEndpoints = createServerFn({ method: "GET" }).handler(
  async (): Promise<IntegrationEndpoints> => {
    await requireAccessToken();
    const config = consoleConfig();
    return {
      platformApi: config.platformApiUrl,
      ...(config.streamGatewayUrl ? { streamGateway: config.streamGatewayUrl } : {}),
      ...(config.oauthCallbackOrigin ? { channelApi: config.oauthCallbackOrigin } : {}),
      ...(config.docsOrigin ? { docs: config.docsOrigin } : {}),
    };
  },
);

/** The install's public origins; they change only with a redeploy. */
export const integrationEndpointsQuery = () =>
  queryOptions({
    queryFn: () => fetchIntegrationEndpoints(),
    queryKey: ["integration-endpoints"],
    staleTime: Number.POSITIVE_INFINITY,
  });
