import { Ulid, type IdentityRepository } from "@deployments-ai/db";
import { type PlatformJwtVerifier } from "@deployments-ai/identity/platform-jwt";
import { Schema } from "effect";
import type { AuthenticatedBrowserSession } from "./session-management.ts";

/** The only client whose tokens may manage the account: the console's confidential BFF. */
export const ACCOUNT_CLIENT_ID = "deployments-web";

const isUlid = Schema.is(Ulid);

export interface AccountCaller extends AuthenticatedBrowserSession {
  readonly principal: { readonly id: Ulid };
  readonly sessionId: Ulid;
}

/**
 * Resolves a console access token to the browser session it was issued from. The token's `sid` is
 * its refresh family; the family, its browser session, and the principal's session epoch must all
 * still be live, so signing out everywhere or revoking that browser session stops the token from
 * changing anything here even before it expires.
 */
export function makeAccountAuthenticator(dependencies: {
  readonly now: () => Date;
  readonly repository: IdentityRepository;
  readonly verify: PlatformJwtVerifier;
}) {
  return async (authorization: string | undefined): Promise<AccountCaller | undefined> => {
    if (!authorization?.startsWith("Bearer ")) return undefined;
    const payload = await dependencies.verify(authorization.slice(7)).catch(() => undefined);
    const principalId = payload?.sub;
    const familyId = payload?.sid;
    if (payload?.client_id !== ACCOUNT_CLIENT_ID || !isUlid(principalId) || !isUlid(familyId)) {
      return undefined;
    }
    const timestamp = dependencies.now().getTime();
    const [family, securityState, principal] = await Promise.all([
      dependencies.repository.refreshFamilyForId(familyId),
      dependencies.repository.securityStateForPrincipal(principalId),
      dependencies.repository.principalForId(principalId),
    ]);
    const sessionId = family?.data.browserSessionId;
    if (
      !family ||
      !sessionId ||
      family.data.status !== "active" ||
      family.data.principalId !== principalId ||
      family.data.clientId !== ACCOUNT_CLIENT_ID ||
      Date.parse(family.data.expiresAt) <= timestamp ||
      principal?.data.status !== "active" ||
      securityState?.data.sessionEpoch !== family.data.sessionEpoch
    ) {
      return undefined;
    }
    const locator = await dependencies.repository.sessionLocator(principalId, sessionId);
    const session =
      locator?.data.status === "active"
        ? await dependencies.repository.sessionForHash(locator.data.sessionTokenHash)
        : undefined;
    if (
      session?.data.status !== "active" ||
      session.data.id !== sessionId ||
      session.data.principalId !== principalId ||
      session.data.sessionEpoch !== family.data.sessionEpoch ||
      Date.parse(session.data.expiresAt) <= timestamp ||
      Date.parse(session.data.idleExpiresAt) <= timestamp
    ) {
      return undefined;
    }
    return { principal: { id: principalId }, sessionId };
  };
}

export type AccountAuthenticator = ReturnType<typeof makeAccountAuthenticator>;
