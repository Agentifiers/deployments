import {
  makeIdentityRepository,
  sessionRecords,
  type PlatformRecord,
  type Ulid,
} from "@deployments-ai/db";
import {
  makeFederationJwksCache,
  sha256,
  sha256Base64Url,
  type FederationHttp,
  type FederationHttpResponse,
} from "@deployments-ai/identity";
import {
  CONNECTION,
  EXISTING_PRINCIPAL,
  ISSUER,
  ORGANIZATION,
  START,
  signInHarness,
} from "../../../packages/db/src/identity-federation/test-support.ts";
import {
  jsonResponse,
  signIdToken,
  signingKey,
  type SigningKey,
} from "../../../packages/identity/src/federation/testing/fake-identity-provider.ts";
import { makeIdentityApplication } from "./application.ts";
import { makeFederationApplication } from "./federation-application.ts";
import { sequentialIds } from "./session-management.fixture.ts";

export const IDENTITY_ISSUER = "https://auth.deployments.ai";
export const APPLICATION_ORIGIN = "https://app.deployments.ai";
export const CALLBACK_URL = `${IDENTITY_ISSUER}/oauth2/federation/callback/${ORGANIZATION}`;
const CLIENT_ID = "0oa-client";
const CLIENT_SECRET = "plaintext-client-secret";

export interface IdentityProviderUser {
  readonly authTime?: number;
  readonly email: string;
  readonly subject: string;
}

export type UserinfoAnswer =
  | { readonly kind: "claims"; readonly email?: string; readonly emailVerified: boolean }
  | { readonly kind: "missing-subject" }
  | { readonly kind: "other-subject" }
  | { readonly kind: "signed-jwt" }
  | { readonly kind: "unauthorized" };

export type ClaimRelease =
  | { readonly kind: "entra-id" }
  | { readonly kind: "google-workspace"; readonly hostedDomain: string }
  | { readonly kind: "id-token"; readonly emailVerified: boolean }
  | {
      readonly kind: "okta-code-flow";
      readonly accessToken: "absent" | "bearer";
      readonly userinfo: UserinfoAnswer;
    };

export interface UserinfoRequest {
  readonly authorization: string | undefined;
  readonly method: string;
}

interface Grant {
  readonly codeChallenge: string;
  readonly nonce: string;
  readonly redirectUri: string;
  readonly user: IdentityProviderUser;
}

function releasedEmailClaims(
  release: ClaimRelease,
  user: IdentityProviderUser,
): Readonly<Record<string, unknown>> {
  switch (release.kind) {
    case "entra-id":
      return { email: user.email, xms_edov: true };
    case "google-workspace":
      return { email: user.email, email_verified: true, hd: release.hostedDomain };
    case "id-token":
      return { email: user.email, email_verified: release.emailVerified };
    case "okta-code-flow":
      return { email: user.email };
    default: {
      const unhandled: never = release;
      return unhandled;
    }
  }
}

async function userinfoResponse(
  answer: UserinfoAnswer,
  user: IdentityProviderUser,
  key: SigningKey,
): Promise<FederationHttpResponse> {
  switch (answer.kind) {
    case "claims":
      return jsonResponse(200, {
        email: answer.email ?? user.email,
        email_verified: answer.emailVerified,
        sub: user.subject,
      });
    case "missing-subject":
      return jsonResponse(200, { email: user.email, email_verified: true });
    case "other-subject":
      return jsonResponse(200, { email: user.email, email_verified: true, sub: "00u-mallory" });
    case "signed-jwt":
      return {
        body: await signIdToken(key, {
          email: user.email,
          email_verified: true,
          sub: user.subject,
        }),
        headers: new Headers({ "content-type": "application/jwt" }),
        status: 200,
      };
    case "unauthorized":
      return jsonResponse(401, { error: "invalid_token" });
    default: {
      const unhandled: never = answer;
      return unhandled;
    }
  }
}

export async function federationFixture(
  records: readonly PlatformRecord[],
  options: { readonly release?: ClaimRelease } = {},
) {
  const release = options.release ?? { emailVerified: true, kind: "id-token" };
  const harness = signInHarness(records);
  let clock = Date.parse(START);
  const now = () => new Date(clock);
  const key = await signingKey("RS256", "acme-key");
  const grants = new Map<string, Grant>();
  const bearerTokens = new Map<string, IdentityProviderUser>();
  let issuedCodes = 0;
  const tokenRequests: string[] = [];
  const userinfoRequests: UserinfoRequest[] = [];
  const token: FederationHttp = async (request) => {
    const form = new URLSearchParams(request.body);
    const code = form.get("code") ?? "";
    tokenRequests.push(code);
    const grant = grants.get(code);
    grants.delete(code);
    const basic = `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`;
    if (request.headers.authorization !== basic) {
      return jsonResponse(401, { error: "invalid_client" });
    }
    if (
      !grant ||
      sha256Base64Url(form.get("code_verifier") ?? "") !== grant.codeChallenge ||
      form.get("redirect_uri") !== grant.redirectUri
    ) {
      return jsonResponse(400, { error: "invalid_grant" });
    }
    const issuedAt = Math.floor(clock / 1_000);
    const idToken = await signIdToken(key, {
      aud: CLIENT_ID,
      ...(grant.user.authTime === undefined ? {} : { auth_time: grant.user.authTime }),
      ...releasedEmailClaims(release, grant.user),
      exp: issuedAt + 300,
      iat: issuedAt,
      iss: ISSUER,
      nonce: grant.nonce,
      sub: grant.user.subject,
    });
    const accessToken = `access-${code}`;
    const issuesAccessToken = release.kind !== "okta-code-flow" || release.accessToken === "bearer";
    if (issuesAccessToken) bearerTokens.set(`Bearer ${accessToken}`, grant.user);
    return jsonResponse(200, {
      ...(issuesAccessToken ? { access_token: accessToken } : {}),
      id_token: idToken,
      token_type: "Bearer",
    });
  };
  const userinfo: FederationHttp = async (request) => {
    userinfoRequests.push({ authorization: request.headers.authorization, method: request.method });
    const user = bearerTokens.get(request.headers.authorization ?? "");
    if (request.method !== "GET" || !user) return jsonResponse(401, { error: "invalid_token" });
    const answer: UserinfoAnswer =
      release.kind === "okta-code-flow"
        ? release.userinfo
        : { emailVerified: true, kind: "claims" };
    return userinfoResponse(answer, user, key);
  };
  const http: FederationHttp = async (request) => {
    switch (request.url) {
      case `${ISSUER}/oauth2/v1/keys`:
        return jsonResponse(200, { keys: [key.publicJwk] });
      case `${ISSUER}/oauth2/v1/token`:
        return token(request);
      case `${ISSUER}/oauth2/v1/userinfo`:
        return userinfo(request);
      default:
        return jsonResponse(404, {});
    }
  };
  const federation = makeFederationApplication(
    {
      decryptEnvelope: async (_envelope, binding) =>
        binding.purpose === "identity-provider-client-secret" &&
        binding.organizationId === ORGANIZATION &&
        binding.connectionId === CONNECTION
          ? CLIENT_SECRET
          : Promise.reject(new Error("KMS rejected the encryption context.")),
      http,
      jwks: makeFederationJwksCache({ http, now }),
      now,
      store: harness.store,
    },
    { applicationOrigin: APPLICATION_ORIGIN, issuer: IDENTITY_ISSUER },
  );
  const identity = makeIdentityApplication(
    {
      encryptEmailPayload: async () => {
        throw new Error("Unexpected email encryption.");
      },
      generateId: sequentialIds(),
      now,
      repository: makeIdentityRepository(harness.memory.database),
    },
    {
      actionLifetimeSeconds: 1_800,
      sessionAbsoluteLifetimeSeconds: 86_400,
      sessionIdleLifetimeSeconds: 3_600,
    },
  );
  return {
    advance(milliseconds: number) {
      clock += milliseconds;
      harness.advance(milliseconds);
    },
    federation,
    harness,
    identity,
    identityProviderRedirect(location: string, user: IdentityProviderUser) {
      const request = new URL(location).searchParams;
      const code = `code-${(issuedCodes += 1)}`;
      grants.set(code, {
        codeChallenge: request.get("code_challenge") ?? "",
        nonce: request.get("nonce") ?? "",
        redirectUri: request.get("redirect_uri") ?? "",
        user,
      });
      return { code, state: request.get("state") ?? "" };
    },
    now,
    passwordSession(id: Ulid) {
      const rawToken = `password-session-${id}`;
      const { session } = sessionRecords({
        authentication: { method: "password" },
        authenticationTime: START,
        createdAt: START,
        expiresAt: "2026-10-09T12:00:00.000Z",
        id,
        idleExpiresAt: "2026-10-08T13:00:00.000Z",
        principalId: EXISTING_PRINCIPAL,
        sessionEpoch: 3,
        tokenHash: sha256(rawToken),
      });
      harness.memory.put(session);
      return rawToken;
    },
    tokenRequests,
    userinfoRequests,
  };
}
