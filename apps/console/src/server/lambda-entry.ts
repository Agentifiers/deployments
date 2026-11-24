import { useNitroApp } from "nitro/app";
import { consoleConfig } from "./config.ts";
import {
  httpApiRequest,
  httpApiResult,
  type HttpApiEvent,
  type HttpApiResult,
} from "./http-api.ts";

const nitroApp = useNitroApp();

/**
 * Lambda entry for the console behind CloudFront and an API Gateway HTTP API (payload 2.0). It
 * replaces nitro's generic AWS adapter, which builds URLs from the execute-api `Host`, joins
 * request cookies with ", ", and returns `Set-Cookie` both in `cookies` and as a comma-joined
 * header, so API Gateway would emit malformed duplicates.
 */
export async function handler(event: HttpApiEvent): Promise<HttpApiResult> {
  const request = httpApiRequest(event, consoleConfig().publicOrigin);
  return httpApiResult(await nitroApp.fetch(request));
}
