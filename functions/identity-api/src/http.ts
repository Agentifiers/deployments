import {
  authorizationServerMetadata,
  type HumanVerifier,
  IdentityError,
  oauthErrorBody,
  openIdConfiguration,
  parseScopes,
  randomToken,
  redirectUriMatches,
  sha256,
  validateAuthorizationRequest,
} from "@deployments-ai/identity";
import { REAUTHENTICATION_TOKEN_PARAMETER, safeReturnTo } from "./authorize-continuation.ts";
import type { IdentityApplication } from "./application.ts";
import type { DeviceApplication } from "./device-application.ts";
import type { FederationApplication } from "./federation-application.ts";
import { federationResponse } from "./federation-http.ts";
import type { OAuthApplication } from "./oauth-application.ts";
import type { JwtSigner } from "./signer.ts";
import { sourcePrefixHash } from "./request-source.ts";
import { authorizationConsentUi, authUi, federationLinkUi } from "./identity-ui.ts";
import { cookie, empty, json, redirect, type RestApiResponse } from "./http-responses.ts";
import { cookies, header, parseBody, parseForm } from "./http-request.ts";
import { acceptPublicEmailRequest, requireHuman } from "./public-email-response.ts";
import type { QueuedPublicEmailRequest } from "./public-email-requests.ts";
import { sessionManagementResponse } from "./session-management-http.ts";
import type { AccountAuthenticator } from "./account-authentication.ts";
import { accountResponse } from "./account-http.ts";
import { accountDeviceResponse } from "./account-device-http.ts";
import { emailChangeLinkResponse } from "./account-lifecycle-http.ts";
import { deviceLabel } from "./device-label.ts";
import { emailChangeUi } from "./email-change-ui.ts";
import { signInResponse } from "./sign-in-http.ts";

export type { RestApiResponse } from "./http-responses.ts";

export interface RestApiEvent {
  readonly body?: string | null;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly httpMethod?: string;
  readonly isBase64Encoded?: boolean;
  readonly path?: string;
  readonly queryStringParameters?: Readonly<Record<string, string | undefined>> | null;
  readonly requestContext?: {
    readonly identity?: { readonly sourceIp?: string };
    readonly requestId?: string;
  };
}

export interface IdentityHttpConfig {
  /** Authenticates the console's bearer token for `/v1/account/`; absent, those routes 404. */
  readonly accountAuthenticator?: AccountAuthenticator;
  readonly applicationOrigin: string;
  readonly humanVerifier?: HumanVerifier;
  readonly issuer: string;
  readonly publicResponseMinimumMs: number;
  readonly queuePublicEmailRequest: (request: QueuedPublicEmailRequest) => Promise<void>;
  readonly registrationEnabled: boolean;
  readonly secureCookies: boolean;
  readonly uiOrigin: string;
}

const sessionCookieName = (secure: boolean) => (secure ? "__Host-dpl_identity" : "dpl_identity");
const csrfCookieName = (secure: boolean) => (secure ? "__Host-dpl_csrf" : "dpl_csrf");
const publicEmailOperations: Record<string, QueuedPublicEmailRequest["operation"]> = {
  "/v1/auth/password/forgot": "password-recovery",
  "/v1/auth/sign-up": "sign-up",
};

function clientAuthentication(event: RestApiEvent, form: Readonly<Record<string, string>>) {
  const authorization = header(event, "authorization");
  if (!authorization) return { clientId: form.client_id ?? "" };
  if (!authorization.startsWith("Basic ")) {
    throw new IdentityError("invalid_client", "Unsupported client authentication.");
  }
  const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 1) throw new IdentityError("invalid_client", "Client authentication failed.");
  try {
    return {
      clientId: decodeURIComponent(decoded.slice(0, separator)),
      clientSecret: decodeURIComponent(decoded.slice(separator + 1)),
    };
  } catch {
    throw new IdentityError("invalid_client", "Client authentication failed.");
  }
}

const CSRF_TOKEN = /^[\w-]{43}$/u;

/** A browser's existing CSRF token when it is one we could have issued, else a fresh one. */
function reusableCsrf(existing: string | undefined) {
  return existing && CSRF_TOKEN.test(existing) ? existing : randomToken();
}

function requiredText(body: Record<string, unknown>, name: string) {
  const value = body[name];
  if (typeof value !== "string" || !value) {
    throw new IdentityError("invalid_request", `${name} is required.`, {
      exposeDescription: true,
    });
  }
  return value;
}

function assertMutationRequest(event: RestApiEvent, config: IdentityHttpConfig) {
  const origin = header(event, "origin");
  if (origin !== config.uiOrigin) {
    throw new IdentityError("invalid_request", "Request origin is not allowed.", { status: 403 });
  }
  const jar = cookies(event);
  const csrf = header(event, "x-csrf-token");
  const csrfCookie = jar[csrfCookieName(config.secureCookies)];
  if (!csrfCookie || !csrf || sha256(csrfCookie) !== sha256(csrf)) {
    throw new IdentityError("invalid_request", "CSRF validation failed.", {
      status: 403,
    });
  }
}

function parsePrompt(value: string | undefined) {
  if (!value) return new Set<string>();
  const values = value.split(" ");
  if (
    values.some((prompt) => !prompt) ||
    values.some((prompt) => prompt !== "login" && prompt !== "none") ||
    (values.includes("none") && values.length !== 1)
  ) {
    throw new IdentityError("invalid_request", "The prompt parameter is invalid.");
  }
  return new Set(values);
}

function authorizationRequestFingerprint(
  parameters: Readonly<Record<string, string | undefined>>,
  requestedScopes: readonly string[],
) {
  return sha256(
    JSON.stringify([
      parameters.client_id ?? "",
      parameters.redirect_uri ?? "",
      parameters.response_type ?? "",
      requestedScopes,
      parameters.code_challenge ?? "",
      parameters.code_challenge_method ?? "",
      parameters.nonce ?? "",
      parameters.state ?? "",
    ]),
  );
}

function authorizationSignInRedirect(
  parameters: Readonly<Record<string, string | undefined>>,
  issuer: string,
  omitLoginPrompt: boolean,
  organizationId?: string,
) {
  const continuation = new URL(`${issuer}/oauth2/authorize`);
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined && !(omitLoginPrompt && name === "prompt")) {
      continuation.searchParams.set(name, value);
    }
  }
  const signIn = new URL(`${issuer}/sign-in`);
  if (organizationId) signIn.searchParams.set("organization", organizationId);
  signIn.searchParams.set("return_to", `${continuation.pathname}${continuation.search}`);
  return redirect(signIn.toString());
}

export function makeIdentityHttpHandler(
  application: IdentityApplication,
  config: IdentityHttpConfig,
  protocol?: {
    readonly device: DeviceApplication;
    readonly oauth: OAuthApplication;
    readonly signer: JwtSigner;
  },
  federation?: FederationApplication,
) {
  return async (event: RestApiEvent): Promise<RestApiResponse> => {
    const method = event.httpMethod ?? "GET";
    const path = event.path ?? "/";
    try {
      if (method === "GET" && path === "/.well-known/openid-configuration") {
        return json(200, openIdConfiguration(config.issuer));
      }
      if (method === "GET" && path === "/.well-known/oauth-authorization-server") {
        return json(200, authorizationServerMetadata(config.issuer));
      }
      if (method === "GET" && path === "/.well-known/jwks.json" && protocol) {
        return json(200, await protocol.signer.jwks(), {
          "Cache-Control": "public, max-age=300",
        });
      }
      if (
        method === "GET" &&
        (path === "/email-change/confirm" || path === "/email-change/report")
      ) {
        return emailChangeUi({
          applicationOrigin: config.applicationOrigin,
          csrf: randomToken(),
          csrfCookieName: csrfCookieName(config.secureCookies),
          kind: path === "/email-change/confirm" ? "confirm" : "report",
          secure: config.secureCookies,
        });
      }
      if (method === "GET" && path === "/federation/confirm-link") {
        return federationLinkUi({
          csrf: randomToken(),
          csrfCookieName: csrfCookieName(config.secureCookies),
          secure: config.secureCookies,
        });
      }
      if (method === "GET" && path === "/device") {
        // A `#code=` fragment from an older CLI survives the redirect; browsers carry it over.
        const code = event.queryStringParameters?.code;
        const page = new URL("/device", config.applicationOrigin);
        if (code) page.searchParams.set("code", code);
        return redirect(page.toString());
      }
      if (
        method === "GET" &&
        ["/sign-in", "/sign-up", "/verify", "/reset-password"].includes(path)
      ) {
        if (!config.registrationEnabled && (path === "/sign-up" || path === "/verify")) {
          throw new IdentityError("access_denied", "Registration is not enabled.", {
            status: 404,
          });
        }
        const returnTo =
          path === "/sign-in" ? safeReturnTo(event.queryStringParameters?.return_to) : undefined;
        const organization =
          path === "/sign-in"
            ? await federation?.organization(event.queryStringParameters?.organization)
            : undefined;
        return authUi({
          applicationOrigin: config.applicationOrigin,
          // Reuse a well-formed token the browser already holds: a page left open in another tab,
          // or a sign-in page rendered twice by a redirect chain, keeps a token its cookie matches.
          csrf: reusableCsrf(cookies(event)[csrfCookieName(config.secureCookies)]),
          csrfCookieName: csrfCookieName(config.secureCookies),
          initialMode: path === "/sign-up" ? "sign-up" : "sign-in",
          ...(config.humanVerifier ? { humanVerification: config.humanVerifier.widget } : {}),
          ...(organization ? { organization } : {}),
          registrationEnabled: config.registrationEnabled,
          ...(returnTo ? { returnTo } : {}),
          secure: config.secureCookies,
        });
      }
      if (method === "GET" && path === "/v1/auth/session") {
        const rawSession = cookies(event)[sessionCookieName(config.secureCookies)];
        const session = rawSession ? await application.session(rawSession) : undefined;
        return session ? json(200, session) : json(401, { error: "unauthorized" });
      }
      if (method === "GET" && path === "/oauth2/authorize" && protocol) {
        const parameters = event.queryStringParameters ?? {};
        const client = await protocol.oauth.client(parameters.client_id ?? "");
        const requestedScopes = validateAuthorizationRequest({
          client: client.data,
          ...(parameters.code_challenge ? { codeChallenge: parameters.code_challenge } : {}),
          ...(parameters.code_challenge_method
            ? { codeChallengeMethod: parameters.code_challenge_method }
            : {}),
          ...(parameters.nonce ? { nonce: parameters.nonce } : {}),
          redirectUri: parameters.redirect_uri ?? "",
          responseType: parameters.response_type ?? "",
          scopes: parseScopes(parameters.scope),
        });
        const prompt = parsePrompt(parameters.prompt);
        const rawSession = cookies(event)[sessionCookieName(config.secureCookies)];
        const browser = rawSession ? await application.session(rawSession) : undefined;
        const requestFingerprint = authorizationRequestFingerprint(parameters, requestedScopes);
        const hint = await federation?.organizationHint({
          browser: browser && {
            authentication: browser.authentication,
            principalId: browser.principal.id,
          },
          hint: parameters.organization_hint,
        });
        const signInOrganization = hint?.kind === "ignored" ? undefined : hint?.organizationId;
        if (!browser || hint?.kind === "sign-in") {
          if (prompt.has("none")) {
            throw new IdentityError("login_required", "Authentication is required.");
          }
        }
        if (prompt.has("login")) {
          const reauthenticationToken = await protocol.oauth.beginReauthentication({
            ...(browser ? { previousSessionId: browser.sessionId } : {}),
            requestFingerprint,
          });
          return authorizationSignInRedirect(
            { ...parameters, [REAUTHENTICATION_TOKEN_PARAMETER]: reauthenticationToken },
            config.issuer,
            true,
            signInOrganization,
          );
        }
        if (!browser || hint?.kind === "sign-in") {
          return authorizationSignInRedirect(parameters, config.issuer, false, signInOrganization);
        }
        const reauthenticationToken = parameters[REAUTHENTICATION_TOKEN_PARAMETER];
        const authenticatedBrowser = {
          authenticationTime: browser.authenticationTime,
          principalId: browser.principal.id,
          sessionId: browser.sessionId,
        };
        if (parameters.client_id === "deployments-cli") {
          if (prompt.has("none")) {
            throw new IdentityError("consent_required", "Interactive consent is required.");
          }
          const requestHandle = await protocol.oauth.beginAuthorizationInteraction({
            browserSession: authenticatedBrowser,
            clientId: parameters.client_id,
            ...(parameters.code_challenge ? { codeChallenge: parameters.code_challenge } : {}),
            ...(parameters.code_challenge_method
              ? { codeChallengeMethod: parameters.code_challenge_method }
              : {}),
            ...(parameters.nonce ? { nonce: parameters.nonce } : {}),
            redirectUri: parameters.redirect_uri ?? "",
            ...(reauthenticationToken ? { reauthenticationToken, requestFingerprint } : {}),
            responseType: parameters.response_type ?? "",
            scopes: requestedScopes,
            ...(parameters.state ? { state: parameters.state } : {}),
          });
          return authorizationConsentUi(
            requestHandle,
            randomToken(),
            csrfCookieName(config.secureCookies),
            config.secureCookies,
            client.data.name,
            requestedScopes,
          );
        }
        const location = await protocol.oauth.authorize({
          browserSession: authenticatedBrowser,
          clientId: parameters.client_id ?? "",
          ...(parameters.code_challenge ? { codeChallenge: parameters.code_challenge } : {}),
          ...(parameters.code_challenge_method
            ? { codeChallengeMethod: parameters.code_challenge_method }
            : {}),
          confirmed: true,
          ...(parameters.nonce ? { nonce: parameters.nonce } : {}),
          redirectUri: parameters.redirect_uri ?? "",
          ...(reauthenticationToken ? { reauthenticationToken, requestFingerprint } : {}),
          responseType: parameters.response_type ?? "",
          scopes: requestedScopes,
          ...(parameters.state ? { state: parameters.state } : {}),
        });
        return redirect(location);
      }
      if (method === "POST" && path === "/oauth2/token" && protocol) {
        const form = parseForm(event);
        const authenticated = clientAuthentication(event, form);
        const result =
          form.grant_type === "authorization_code"
            ? await protocol.oauth.exchangeAuthorizationCode({
                clientId: authenticated.clientId,
                ...(authenticated.clientSecret ? { clientSecret: authenticated.clientSecret } : {}),
                code: form.code ?? "",
                codeVerifier: form.code_verifier ?? "",
                redirectUri: form.redirect_uri ?? "",
              })
            : form.grant_type === "refresh_token"
              ? await protocol.oauth.exchangeRefreshToken({
                  clientId: authenticated.clientId,
                  ...(authenticated.clientSecret
                    ? { clientSecret: authenticated.clientSecret }
                    : {}),
                  refreshToken: form.refresh_token ?? "",
                  ...(form.scope ? { scopes: form.scope.split(" ").filter(Boolean) } : {}),
                })
              : form.grant_type === "urn:ietf:params:oauth:grant-type:device_code"
                ? await protocol.device.poll({
                    clientId: authenticated.clientId,
                    deviceCode: form.device_code ?? "",
                  })
                : (() => {
                    throw new IdentityError("unsupported_grant_type", "Grant type is unsupported.");
                  })();
        return json(200, result, { Pragma: "no-cache" });
      }
      if (method === "POST" && path === "/oauth2/revoke" && protocol) {
        const form = parseForm(event);
        const authenticated = clientAuthentication(event, form);
        await protocol.oauth.revokeRefreshToken({
          clientId: authenticated.clientId,
          ...(authenticated.clientSecret ? { clientSecret: authenticated.clientSecret } : {}),
          refreshToken: requiredText(form, "token"),
        });
        return empty(200, { Pragma: "no-cache" });
      }
      if (method === "POST" && path === "/oauth2/device_authorization" && protocol) {
        const form = parseForm(event);
        return json(
          200,
          await protocol.device.authorize({
            clientId: form.client_id ?? "",
            scopes: (form.scope ?? "").split(" ").filter(Boolean),
          }),
          { Pragma: "no-cache" },
        );
      }
      const accountDevice =
        config.accountAuthenticator && protocol
          ? await accountDeviceResponse(protocol.device, config.accountAuthenticator, {
              authorization: header(event, "authorization"),
              method,
              path,
              readBody: () => parseBody(event),
            })
          : undefined;
      if (accountDevice) return accountDevice;
      const account = config.accountAuthenticator
        ? await accountResponse(application, config.accountAuthenticator, {
            authorization: header(event, "authorization"),
            method,
            path,
            query: event.queryStringParameters ?? {},
            readBody: () => parseBody(event),
          })
        : undefined;
      if (account) return account;
      if ((method === "POST" || method === "DELETE") && path.startsWith("/v1/")) {
        assertMutationRequest(event, config);
      }
      const sessionManagement = await sessionManagementResponse(application, {
        clearSessionCookie: cookie(sessionCookieName(config.secureCookies), "", {
          httpOnly: true,
          maxAge: 0,
          secure: config.secureCookies,
        }),
        method,
        path,
        query: event.queryStringParameters ?? {},
        rawSession: cookies(event)[sessionCookieName(config.secureCookies)] ?? "",
      });
      if (sessionManagement) return sessionManagement;
      const emailChangeLink = await emailChangeLinkResponse(application, {
        method,
        path,
        readBody: () => parseBody(event),
      });
      if (emailChangeLink) return emailChangeLink;
      const userAgent = header(event, "user-agent");
      const federated = await federationResponse(federation, {
        browserPrincipalId: async () => {
          const rawSession = cookies(event)[sessionCookieName(config.secureCookies)];
          return rawSession ? (await application.session(rawSession))?.principal.id : undefined;
        },
        cookies: cookies(event),
        csrfCookieName: csrfCookieName(config.secureCookies),
        deviceLabel: deviceLabel(userAgent),
        ipPrefixHash: sourcePrefixHash(event),
        method,
        path,
        query: event.queryStringParameters ?? {},
        readBody: () => parseBody(event),
        readForm: (maxBytes) => parseForm(event, maxBytes),
        secureCookies: config.secureCookies,
        sessionCookieName: sessionCookieName(config.secureCookies),
        userAgentHash: userAgent && sha256(userAgent),
      });
      if (federated) return federated;
      if (method === "POST" && path === "/v1/oauth/authorize" && protocol) {
        const body = parseBody(event);
        const rawSession = cookies(event)[sessionCookieName(config.secureCookies)];
        const browser = rawSession ? await application.session(rawSession) : undefined;
        if (!browser) {
          throw new IdentityError("access_denied", "Session is invalid.", { status: 401 });
        }
        const authorized = await protocol.oauth.confirmAuthorizationInteraction({
          browserSession: {
            authenticationTime: browser.authenticationTime,
            principalId: browser.principal.id,
            sessionId: browser.sessionId,
          },
          clientId: "deployments-cli",
          requestHandle: requiredText(body, "request_handle"),
        });
        return json(200, { redirect: authorized });
      }
      // The operator token command and the e2e harness approve with a password cookie session.
      if (
        method === "POST" &&
        (path === "/v1/device/claim" || path === "/v1/device/approve") &&
        protocol
      ) {
        const body = parseBody(event);
        const rawSession = cookies(event)[sessionCookieName(config.secureCookies)];
        const browser = rawSession ? await application.session(rawSession) : undefined;
        if (!browser) {
          throw new IdentityError("access_denied", "Session is invalid.", {
            status: 401,
          });
        }
        const approver = { principalId: browser.principal.id, sessionId: browser.sessionId };
        const userCode = requiredText(body, "userCode");
        if (path === "/v1/device/claim") {
          return json(200, await protocol.device.claim(userCode, approver));
        }
        await protocol.device.decide(userCode, approver, "approved");
        return json(204, "");
      }
      const publicEmailOperation =
        method === "POST" && Object.hasOwn(publicEmailOperations, path)
          ? publicEmailOperations[path]
          : undefined;
      if (publicEmailOperation) {
        if (publicEmailOperation === "sign-up" && !config.registrationEnabled) {
          throw new IdentityError("access_denied", "Registration is not enabled.", {
            status: 403,
          });
        }
        const started = Date.now();
        const body = parseBody(event);
        const email = requiredText(body, "email");
        const sourceHash = sourcePrefixHash(event);
        return await acceptPublicEmailRequest({
          minimumMs: config.publicResponseMinimumMs,
          operation: publicEmailOperation,
          request: async () => {
            await requireHuman(
              config.humanVerifier,
              body,
              event.requestContext?.identity?.sourceIp,
            );
            await config.queuePublicEmailRequest({
              email,
              operation: publicEmailOperation,
              ...(sourceHash ? { sourcePrefixHash: sourceHash } : {}),
            });
          },
          ...(event.requestContext?.requestId ? { requestId: event.requestContext.requestId } : {}),
          startedAt: started,
        });
      }
      if (method === "POST" && path === "/v1/auth/verify-email") {
        if (!config.registrationEnabled) {
          throw new IdentityError("access_denied", "Registration is not enabled.", {
            status: 403,
          });
        }
        const body = parseBody(event);
        const verified = await application.verifyEmail({
          ...(typeof body.displayName === "string" && body.displayName
            ? { displayName: body.displayName }
            : {}),
          password: requiredText(body, "password"),
          token: requiredText(body, "token"),
        });
        return json(200, verified);
      }
      if (method === "POST" && path === "/v1/auth/password/reset") {
        const body = parseBody(event);
        await application.resetPassword({
          password: requiredText(body, "password"),
          token: requiredText(body, "token"),
        });
        return json(200, { reset: true });
      }
      if (method === "POST" && path === "/v1/auth/password/change") {
        const body = parseBody(event);
        const rawSession = cookies(event)[sessionCookieName(config.secureCookies)];
        const session = rawSession ? await application.session(rawSession) : undefined;
        if (!session) {
          throw new IdentityError("access_denied", "Session is invalid.", { status: 401 });
        }
        await application.changePassword({
          currentPassword: requiredText(body, "currentPassword"),
          password: requiredText(body, "password"),
          principalId: session.principal.id,
        });
        return {
          ...json(200, { changed: true }),
          multiValueHeaders: {
            "Set-Cookie": [
              cookie(sessionCookieName(config.secureCookies), "", {
                httpOnly: true,
                maxAge: 0,
                secure: config.secureCookies,
              }),
            ],
          },
        };
      }
      if (method === "POST" && (path === "/v1/auth/sign-in" || path === "/v1/auth/sign-in/mfa")) {
        return await signInResponse(application, {
          body: parseBody(event),
          ipPrefixHash: sourcePrefixHash(event),
          path,
          publicResponseMinimumMs: config.publicResponseMinimumMs,
          sessionCookie: (value, maxAge) =>
            cookie(sessionCookieName(config.secureCookies), value, {
              httpOnly: true,
              maxAge,
              secure: config.secureCookies,
            }),
          userAgent: header(event, "user-agent"),
        });
      }
      if (method === "POST" && path === "/v1/auth/sign-out-all") {
        const rawSession = cookies(event)[sessionCookieName(config.secureCookies)];
        const session = rawSession ? await application.session(rawSession) : undefined;
        if (!session)
          throw new IdentityError("access_denied", "Session is invalid.", {
            status: 401,
          });
        await application.signOutAll(session.principal.id);
        return json(204, "");
      }
      if (method === "POST" && path === "/v1/auth/sign-out") {
        const rawSession = cookies(event)[sessionCookieName(config.secureCookies)] ?? "";
        await application.signOut(rawSession);
        return {
          ...empty(204),
          multiValueHeaders: {
            "Set-Cookie": [
              cookie(sessionCookieName(config.secureCookies), "", {
                httpOnly: true,
                maxAge: 0,
                secure: config.secureCookies,
              }),
            ],
          },
        };
      }
      return json(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof IdentityError) {
        if (
          method === "GET" &&
          path === "/oauth2/authorize" &&
          protocol &&
          error.code !== "invalid_client"
        ) {
          const clientId = event.queryStringParameters?.client_id;
          const redirectUri = event.queryStringParameters?.redirect_uri;
          if (clientId && redirectUri) {
            try {
              const client = await protocol.oauth.client(clientId);
              if (redirectUriMatches(client.data, redirectUri)) {
                const location = new URL(redirectUri);
                const body = oauthErrorBody(error);
                location.searchParams.set("error", body.error);
                if (body.error_description) {
                  location.searchParams.set("error_description", body.error_description);
                }
                const state = event.queryStringParameters?.state;
                if (state) location.searchParams.set("state", state);
                location.searchParams.set("iss", config.issuer);
                return redirect(location.toString());
              }
            } catch {
              // A client lookup failure cannot establish a trusted redirect target.
            }
          }
        }
        return json(error.status, oauthErrorBody(error));
      }
      if (error instanceof SyntaxError) {
        return json(400, {
          error: "invalid_request",
          error_description: "Invalid JSON.",
        });
      }
      return json(500, { error: "server_error" });
    }
  };
}
