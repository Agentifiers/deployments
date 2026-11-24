import { definePlugin } from "nitro";
import { consoleConfig } from "./config.ts";

/**
 * Nitro initializes plugins while the Lambda module loads, so invalid configuration fails the
 * cold start instead of the first request.
 */
export default definePlugin(() => {
  consoleConfig();
});
