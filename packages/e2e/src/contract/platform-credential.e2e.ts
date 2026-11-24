import { expect, it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";
import { setTimeout as delay } from "node:timers/promises";
import { refreshingPlatformCredential, tenantHeaders } from "../harness/platform-credential.ts";

const TOKEN_LIFETIME_MS = 400;

it.effect(
  "re-mints the platform credential before expiry for captured headers and stops at scope close",
  () =>
    Effect.gen(function* () {
      let minted = 0;
      const mint = Effect.sync(() => {
        minted += 1;
        const issuedAtMs = Date.now();
        return {
          expiresAtMs: issuedAtMs + TOKEN_LIFETIME_MS,
          issuedAtMs,
          token: `token-${minted}`,
        };
      });
      const scope = yield* Scope.make();
      const credential = yield* refreshingPlatformCredential(mint).pipe(Scope.provide(scope));
      const captured = tenantHeaders(credential, {
        environmentId: "env",
        organizationId: "org",
        projectId: "project",
      });
      expect({ ...captured }).toEqual({
        authorization: "Bearer token-1",
        "x-deployments-environment": "env",
        "x-deployments-organization": "org",
        "x-deployments-project": "project",
      });

      yield* Effect.promise(() => delay(TOKEN_LIFETIME_MS * 2));
      expect(minted).toBeGreaterThanOrEqual(2);
      expect(credential.token).toBe(`token-${minted}`);
      expect({ ...captured }.authorization).toBe(`Bearer token-${minted}`);

      yield* Scope.close(scope, Exit.void);
      const mintedAtClose = minted;
      yield* Effect.promise(() => delay(TOKEN_LIFETIME_MS * 2));
      expect(minted).toBe(mintedAtClose);
    }),
);
