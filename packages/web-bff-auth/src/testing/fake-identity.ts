import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from "@aws-sdk/client-kms";
import {
  bffFenceRecord,
  DEFAULT_TABLE_NAMES,
  makeDynamoDatabase,
  makeIdentityRepository,
  makeKmsEnvelopeAdapter,
  Ulid,
  type IdentityRepository,
} from "@deployments-ai/db";
import {
  fakeDynamoDocumentClient,
  type FakeDynamoDocumentClient,
} from "@deployments-ai/db/dynamo-testing";
import { randomToken, sha256, sha256Base64Url } from "@deployments-ai/identity";
import { Schema } from "effect";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from "jose";
import { randomBytes } from "node:crypto";
import { monotonicFactory } from "ulid";
import {
  makeWebBffAuth,
  type CompleteCallbackResult,
  type WebBffAuth,
  type WebBffAuthEvent,
  type WebBffPolicy,
} from "../coordinator.ts";
import { makeOidcClient, SESSION_EPOCH_CLAIM } from "../oidc.ts";

/**
 * In-memory KMS for envelope tests: each data key is retrievable only with its exact encryption
 * context, mirroring KMS's authenticated-context behavior.
 */
export function fakeKmsClient() {
  const keys = new Map<string, { readonly context: string; readonly plaintext: Uint8Array }>();
  const calls = { decrypt: 0, generateDataKey: 0 };
  const client = {
    send: async (command: unknown) => {
      if (command instanceof GenerateDataKeyCommand) {
        calls.generateDataKey += 1;
        const plaintext = new Uint8Array(randomBytes(32));
        const blob = new Uint8Array(randomBytes(24));
        keys.set(Buffer.from(blob).toString("base64"), {
          context: JSON.stringify(command.input.EncryptionContext ?? {}),
          plaintext: plaintext.slice(),
        });
        return { CiphertextBlob: blob, Plaintext: plaintext };
      }
      if (command instanceof DecryptCommand) {
        calls.decrypt += 1;
        const key = keys.get(Buffer.from(command.input.CiphertextBlob ?? []).toString("base64"));
        if (!key || key.context !== JSON.stringify(command.input.EncryptionContext ?? {})) {
          throw Object.assign(new Error("Invalid ciphertext."), {
            name: "InvalidCiphertextException",
          });
        }
        return { Plaintext: key.plaintext.slice() };
      }
      throw new Error("Unexpected KMS command.");
    },
  } as unknown as KMSClient; // Structural stand-in: only `send` is used by the envelope adapter.
  return { calls, client };
}

export type FakeTokenFailure = "ambiguous" | "invalid_grant" | "network";

interface IssuedCode {
  readonly codeChallenge: string;
  readonly nonce: string;
  readonly principalId: string;
  readonly redirectUri: string;
  readonly scope: string;
  readonly sessionEpoch: number;
}

interface RefreshFamily {
  active: boolean;
  readonly principalId: string;
  readonly scope: string;
}

export interface FakeIdentityControl {
  accessTokenOverrides: JWTPayload | undefined;
  /** Fails the next token-endpoint request of the given grant type. */
  failNext: { readonly grant: string; readonly kind: FakeTokenFailure } | undefined;
  /** Makes the revocation endpoint answer 503. */
  failRevocations: boolean;
  /** Adds or overrides claims of the next issued ID token (e.g. a wrong nonce). */
  idTokenOverrides: JWTPayload | undefined;
  /** Signs the next ID token with a key absent from the JWKS. */
  signNextIdTokenWithRogueKey: boolean;
  /** Awaited after a refresh rotates and before it answers; lets tests interleave requests. */
  tokenGate: (() => Promise<void>) | undefined;
}

export interface FakeIdentityStats {
  /** Raw tokens accepted by the revocation endpoint, in order. */
  readonly revoked: string[];
  readonly tokenRequests: Record<string, number>;
}

export interface FakeIdentityServer {
  /** Plays the browser + sign-in UI and returns the callback query parameters. */
  readonly authorize: (
    authorizationUrl: string,
    principal: { readonly principalId: string; readonly sessionEpoch: number },
  ) => { readonly code: string; readonly iss: string; readonly state: string };
  readonly control: FakeIdentityControl;
  readonly familyActiveForToken: (refreshToken: string) => boolean;
  readonly fetch: typeof fetch;
  readonly stats: FakeIdentityStats;
}

export interface WebBffTestHarness {
  readonly auth: WebBffAuth;
  /** Shared mutable clock for the coordinator, OIDC validation, and the fake issuer. */
  readonly clock: { now: Date };
  readonly dynamo: FakeDynamoDocumentClient;
  readonly generateId: () => Ulid;
  /** SHA-256 hex of a raw cookie value, as the repository keys records. */
  readonly hash: (value: string) => string;
  readonly issuer: string;
  readonly kms: { readonly calls: { decrypt: number; generateDataKey: number } };
  readonly redirectUri: string;
  readonly repository: IdentityRepository;
  readonly server: FakeIdentityServer;
  readonly setFence: (
    principalId: string,
    fence: {
      readonly principalStatus?: "active" | "disabled" | "archived";
      readonly sessionEpoch: number;
      readonly version: number;
    },
  ) => void;
  /** Runs login → authorize → callback for the principal. */
  readonly signIn: (principal: {
    readonly principalId: string;
    readonly sessionEpoch: number;
  }) => Promise<CompleteCallbackResult>;
}

export interface WebBffTestHarnessOptions {
  readonly accessTokenSeconds?: number;
  readonly onEvent?: (event: WebBffAuthEvent) => void;
  readonly policy?: Partial<WebBffPolicy>;
}

/**
 * Minimal platform identity issuer for tests: discovery, JWKS, authorization-code + PKCE,
 * rotating refresh tokens with reuse detection, and RFC 7009 revocation. Tokens are real RS256
 * JWTs verifiable through the published JWKS.
 */
export async function makeFakeIdentityServer(input: {
  readonly accessTokenSeconds?: number;
  readonly clientId?: string;
  readonly clientSecret: string;
  readonly issuer: string;
  readonly now: () => Date;
}): Promise<FakeIdentityServer> {
  const clientId = input.clientId ?? "deployments-web";
  const accessTokenSeconds = input.accessTokenSeconds ?? 600;
  const signing = await generateKeyPair("RS256", { extractable: true });
  const rogue = await generateKeyPair("RS256", { extractable: true });
  const publicJwk = {
    ...(await exportJWK(signing.publicKey)),
    alg: "RS256",
    kid: "active",
    use: "sig",
  };
  const codes = new Map<string, IssuedCode>();
  const refreshTokens = new Map<string, { readonly familyId: string; used: boolean }>();
  const families = new Map<string, RefreshFamily>();
  const control: FakeIdentityControl = {
    accessTokenOverrides: undefined,
    failNext: undefined,
    failRevocations: false,
    idTokenOverrides: undefined,
    signNextIdTokenWithRogueKey: false,
    tokenGate: undefined,
  };
  const stats: FakeIdentityStats = {
    revoked: [],
    tokenRequests: { authorization_code: 0, refresh_token: 0 },
  };

  const seconds = () => Math.floor(input.now().getTime() / 1_000);
  const sign = (payload: JWTPayload, key: CryptoKey, kid: string) =>
    new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid, typ: "JWT" }).sign(key);

  async function issue(
    grant: { readonly principalId: string; readonly scope: string },
    extra?: { readonly nonce: string; readonly sessionEpoch: number },
    existingFamilyId?: string,
  ) {
    const iat = seconds();
    const accessTokenOverrides = control.accessTokenOverrides;
    control.accessTokenOverrides = undefined;
    const accessToken = await sign(
      {
        aud: "https://api.test",
        client_id: clientId,
        exp: iat + accessTokenSeconds,
        iat,
        iss: input.issuer,
        jti: randomToken(),
        scope: grant.scope,
        sub: grant.principalId,
        ...accessTokenOverrides,
      },
      signing.privateKey,
      "active",
    );
    const familyId = existingFamilyId ?? randomToken();
    const refreshToken = `dai_rt_${randomToken()}`;
    if (!existingFamilyId) {
      families.set(familyId, { active: true, principalId: grant.principalId, scope: grant.scope });
    }
    refreshTokens.set(refreshToken, { familyId, used: false });
    let idToken: string | undefined;
    if (extra) {
      const rogueKey = control.signNextIdTokenWithRogueKey;
      control.signNextIdTokenWithRogueKey = false;
      const overrides = control.idTokenOverrides;
      control.idTokenOverrides = undefined;
      idToken = await sign(
        {
          aud: clientId,
          auth_time: iat,
          exp: iat + 600,
          iat,
          iss: input.issuer,
          nonce: extra.nonce,
          [SESSION_EPOCH_CLAIM]: extra.sessionEpoch,
          sub: grant.principalId,
          ...overrides,
        },
        rogueKey ? rogue.privateKey : signing.privateKey,
        "active",
      );
    }
    return { accessToken, idToken, refreshToken };
  }

  function authenticate(request: Request) {
    const header = request.headers.get("authorization") ?? "";
    const decoded = Buffer.from(header.replace(/^Basic /u, ""), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return (
      header.startsWith("Basic ") &&
      decodeURIComponent(decoded.slice(0, separator)) === clientId &&
      decodeURIComponent(decoded.slice(separator + 1)) === input.clientSecret
    );
  }

  const oauthError = (error: string, status = 400) => Response.json({ error }, { status });

  async function token(request: Request) {
    const form = new URLSearchParams(await request.text());
    const grant = form.get("grant_type") ?? "";
    stats.tokenRequests[grant] = (stats.tokenRequests[grant] ?? 0) + 1;
    if (!authenticate(request)) return oauthError("invalid_client", 401);
    const failure = control.failNext?.grant === grant ? control.failNext.kind : undefined;
    if (failure) control.failNext = undefined;
    if (grant === "authorization_code") {
      const code = codes.get(form.get("code") ?? "");
      codes.delete(form.get("code") ?? "");
      if (
        !code ||
        code.redirectUri !== form.get("redirect_uri") ||
        sha256Base64Url(form.get("code_verifier") ?? "") !== code.codeChallenge
      ) {
        return oauthError("invalid_grant");
      }
      const issued = await issue(code, { nonce: code.nonce, sessionEpoch: code.sessionEpoch });
      if (failure === "network") throw new TypeError("fetch failed");
      if (failure === "ambiguous") return new Response("upstream timeout", { status: 504 });
      if (failure === "invalid_grant") return oauthError("invalid_grant");
      return Response.json(
        {
          access_token: issued.accessToken,
          expires_in: accessTokenSeconds,
          id_token: issued.idToken,
          refresh_token: issued.refreshToken,
          scope: code.scope,
          token_type: "Bearer",
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (grant === "refresh_token") {
      const presented = refreshTokens.get(form.get("refresh_token") ?? "");
      const family = presented ? families.get(presented.familyId) : undefined;
      if (!presented || !family || !family.active) return oauthError("invalid_grant");
      if (presented.used) {
        family.active = false;
        return oauthError("invalid_grant");
      }
      presented.used = true;
      // The issuer rotates within the same family even when the client never sees the response.
      const issued = await issue(family, undefined, presented.familyId);
      await control.tokenGate?.();
      if (failure === "network") throw new TypeError("fetch failed");
      if (failure === "ambiguous") return new Response("upstream timeout", { status: 504 });
      if (failure === "invalid_grant") return oauthError("invalid_grant");
      return Response.json({
        access_token: issued.accessToken,
        expires_in: accessTokenSeconds,
        refresh_token: issued.refreshToken,
        scope: family.scope,
        token_type: "Bearer",
      });
    }
    return oauthError("unsupported_grant_type");
  }

  async function revoke(request: Request) {
    if (!authenticate(request)) return oauthError("invalid_client", 401);
    if (control.failRevocations) return new Response("unavailable", { status: 503 });
    const form = new URLSearchParams(await request.text());
    const presented = refreshTokens.get(form.get("token") ?? "");
    const family = presented ? families.get(presented.familyId) : undefined;
    if (family) family.active = false;
    stats.revoked.push(form.get("token") ?? "");
    return new Response(null, { status: 200 });
  }

  const fetchHandler = async (resource: string | URL, init?: RequestInit) => {
    const request = new Request(resource.toString(), init);
    const url = new URL(request.url);
    if (url.origin !== new URL(input.issuer).origin) throw new TypeError("unknown host");
    switch (`${request.method} ${url.pathname}`) {
      case "GET /.well-known/openid-configuration":
        return Response.json({
          authorization_endpoint: `${input.issuer}/oauth2/authorize`,
          issuer: input.issuer,
          jwks_uri: `${input.issuer}/.well-known/jwks.json`,
          revocation_endpoint: `${input.issuer}/oauth2/revoke`,
          token_endpoint: `${input.issuer}/oauth2/token`,
        });
      case "GET /.well-known/jwks.json":
        return Response.json({ keys: [publicJwk] });
      case "POST /oauth2/token":
        return token(request);
      case "POST /oauth2/revoke":
        return revoke(request);
      default:
        return new Response("not found", { status: 404 });
    }
  };

  /**
   * Plays the browser + identity UI: validates the authorization request and returns the
   * callback query the issuer would redirect to after the principal signs in.
   */
  function authorize(
    authorizationUrl: string,
    principal: { readonly principalId: string; readonly sessionEpoch: number },
  ) {
    const request = new URL(authorizationUrl);
    const parameters = request.searchParams;
    if (
      parameters.get("client_id") !== clientId ||
      parameters.get("response_type") !== "code" ||
      parameters.get("code_challenge_method") !== "S256" ||
      !parameters.get("nonce") ||
      !parameters.get("state")
    ) {
      throw new Error("Fake issuer rejected the authorization request.");
    }
    const code = randomToken();
    codes.set(code, {
      codeChallenge: parameters.get("code_challenge") ?? "",
      nonce: parameters.get("nonce") ?? "",
      principalId: principal.principalId,
      redirectUri: parameters.get("redirect_uri") ?? "",
      scope: parameters.get("scope") ?? "",
      sessionEpoch: principal.sessionEpoch,
    });
    return { code, iss: input.issuer, state: parameters.get("state") ?? "" };
  }

  return {
    authorize,
    control,
    // Only the call signature is used by the OIDC client; `fetch.preconnect` is never touched.
    fetch: fetchHandler as typeof fetch,
    /** True while the refresh family of `refreshTokenHash`'s token is still usable. */
    familyActiveForToken: (refreshToken: string) => {
      const presented = refreshTokens.get(refreshToken);
      return Boolean(presented && families.get(presented.familyId)?.active);
    },
    stats,
  };
}

const ulid = monotonicFactory();
const generateId = () => Schema.decodeUnknownSync(Ulid)(ulid());

/**
 * Wires the real coordinator, OIDC client, KMS envelope adapter, and identity repository to an
 * in-memory DynamoDB, fake KMS, and fake issuer sharing one controllable clock.
 */
export async function makeWebBffTestHarness(
  options: WebBffTestHarnessOptions = {},
): Promise<WebBffTestHarness> {
  const issuer = "https://auth.test";
  const redirectUri = "https://console.test/auth/callback";
  const clientSecret = randomToken();
  const clock = { now: new Date("2026-10-01T12:00:00.000Z") };
  const now = () => new Date(clock.now.getTime());
  const dynamo = fakeDynamoDocumentClient();
  const repository = makeIdentityRepository(makeDynamoDatabase(dynamo.client, DEFAULT_TABLE_NAMES));
  const kms = fakeKmsClient();
  const envelope = makeKmsEnvelopeAdapter({
    keyId: "alias/console-session",
    kms: kms.client,
    stage: new URL(issuer).host,
  });
  const server = await makeFakeIdentityServer({
    ...(options.accessTokenSeconds ? { accessTokenSeconds: options.accessTokenSeconds } : {}),
    clientSecret,
    issuer,
    now,
  });
  const oidc = makeOidcClient({
    clientId: "deployments-web",
    clientSecret: {
      current: async () => clientSecret,
      invalidate: () => undefined,
    },
    fetch: server.fetch,
    issuer,
    now,
    redirectUri,
  });
  const auth = makeWebBffAuth({
    envelope,
    generateId,
    issuer,
    now,
    oidc,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.policy ? { policy: options.policy } : {}),
    redirectUri,
    repository,
    scopes: ["openid", "offline_access", "organizations:read"],
  });

  /** Writes (or advances) the principal's BFF revocation fence. */
  const setFence: WebBffTestHarness["setFence"] = (principalId, fence) => {
    dynamo.put(
      "identity",
      bffFenceRecord({
        createdAt: clock.now.toISOString(),
        principalId: Schema.decodeUnknownSync(Ulid)(principalId),
        principalStatus: fence.principalStatus ?? "active",
        sessionEpoch: fence.sessionEpoch,
        version: fence.version,
      }),
    );
  };

  /** Runs login → authorize → callback and returns the resulting session cookie. */
  async function signIn(principal: {
    readonly principalId: string;
    readonly sessionEpoch: number;
  }) {
    const login = await auth.beginLogin({ returnTo: "/orgs" });
    const callback = server.authorize(login.authorizationUrl, principal);
    return auth.completeCallback({
      code: callback.code,
      error: undefined,
      iss: callback.iss,
      state: callback.state,
      transactionCookie: login.transactionCookie,
    });
  }

  return {
    auth,
    clock,
    dynamo,
    generateId,
    issuer,
    kms,
    redirectUri,
    repository,
    server,
    setFence,
    signIn,
    hash: sha256,
  };
}
