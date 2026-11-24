import { Effect } from "effect";
import { normalizeOrigins } from "./input.ts";
import {
  BROWSER_SCREENSHOT_ENV_KEYS,
  BrowserScreenshotConfigError,
  type BrowserScreenshotConfig,
} from "./types.ts";

/**
 * Reads the browser target config: any public origin when `DEPLOYMENTS_AI_BROWSER_ANY_PUBLIC_ORIGIN`
 * is `true`, otherwise the exact-origin allowlist merged from every allowlist env alias.
 */
export function readBrowserScreenshotConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
) {
  return Effect.try({
    catch: (cause) =>
      cause instanceof BrowserScreenshotConfigError
        ? cause
        : new BrowserScreenshotConfigError({
            key: BROWSER_SCREENSHOT_ENV_KEYS.allowedOrigins[0],
            message: cause instanceof Error ? cause.message : "Invalid browser screenshot config.",
          }),
    try: (): BrowserScreenshotConfig => {
      const anyPublicOrigin = env[BROWSER_SCREENSHOT_ENV_KEYS.anyPublicOrigin]?.trim() ?? "";
      if (anyPublicOrigin !== "" && anyPublicOrigin !== "true" && anyPublicOrigin !== "false") {
        throw new BrowserScreenshotConfigError({
          key: BROWSER_SCREENSHOT_ENV_KEYS.anyPublicOrigin,
          message: "DEPLOYMENTS_AI_BROWSER_ANY_PUBLIC_ORIGIN must be true or false.",
        });
      }
      if (anyPublicOrigin === "true") return { kind: "any-public" };
      const allowedOrigins = [
        ...normalizeOrigins(
          BROWSER_SCREENSHOT_ENV_KEYS.allowedOrigins.flatMap((key) =>
            (env[key] ?? "")
              .split(/[\n,]/u)
              .map((entry) => entry.trim())
              .filter(Boolean),
          ),
        ),
      ];
      if (allowedOrigins.length === 0) {
        throw new BrowserScreenshotConfigError({
          key: BROWSER_SCREENSHOT_ENV_KEYS.allowedOrigins[0],
          message: "At least one browser screenshot target origin is required.",
        });
      }
      return { allowedOrigins, kind: "origins" };
    },
  });
}
