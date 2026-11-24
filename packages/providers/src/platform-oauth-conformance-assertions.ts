import type { OAuthAppAssertion } from "./platform-oauth-conformance-helpers.ts";
import {
  expectBase,
  expectEqual,
  expectIdentity,
  expectParams,
  expectRequestRevocation,
  fail,
} from "./platform-oauth-conformance-helpers.ts";

export const PLATFORM_OAUTH_ASSERTIONS: Readonly<Record<string, OAuthAppAssertion>> = Object.freeze(
  {
    google(app) {
      const key = "google";
      expectBase(key, app, {
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        clientAuthentication: "client_secret_post",
        pkce: true,
        refreshTokenRequired: true,
        tokenEndpoint: "https://oauth2.googleapis.com/token",
      });
      expectParams(key, "authorizationParams", app.authorizationParams, {
        access_type: "offline",
        include_granted_scopes: "true",
        prompt: "consent",
      });
      expectIdentity(key, app, {
        displayNamePath: "email",
        endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
        idPath: "sub",
      });
      expectEqual(
        key,
        "providerRequestHeaders.google_ads",
        JSON.stringify(Object.keys(app.providerRequestHeaders.google_ads ?? {}).toSorted()),
        JSON.stringify(["developer-token"]),
      );
      expectRequestRevocation(key, app, {
        bodyFormat: "form",
        clientAuthentication: "none",
        credential: "access_token",
        credentialPlacement: "body",
        endpoint: "https://oauth2.googleapis.com/revoke",
        impact: "shared_grant",
        includeClientId: false,
        method: "POST",
        parameterName: "token",
      });
    },
    microsoft(app) {
      const key = "microsoft";
      // Work/school tenants only: Teams Graph APIs are unavailable to personal accounts.
      const authority = "https://login.microsoftonline.com/organizations/oauth2/v2.0";
      expectBase(key, app, {
        authorizationEndpoint: `${authority}/authorize`,
        clientAuthentication: "client_secret_post",
        pkce: true,
        refreshTokenRequired: true,
        tokenEndpoint: `${authority}/token`,
      });
      expectIdentity(key, app, {
        displayNamePath: "userPrincipalName",
        endpoint: "https://graph.microsoft.com/v1.0/me",
        idPath: "id",
      });
      // Microsoft identity platform has no token revocation endpoint; access ends when the
      // user or tenant admin removes the app's consent in Microsoft Entra.
      if (app.revocation) fail(key, "must not configure revocation.");
    },
    shopify(app) {
      const key = "shopify";
      expectBase(key, app, {
        authorizationEndpoint: "https://shopify.com/admin/oauth/authorize",
        authorizationIncludesResponseType: false,
        clientAuthentication: "client_secret_post",
        pkce: false,
        scopeSeparator: "comma",
        tokenEndpoint: "https://shopify.com/admin/oauth/access_token",
        tokenIncludesGrantType: false,
        tokenIncludesRedirectUri: false,
      });
      if (!app.revocation || app.revocation.mode !== "provider_event") {
        fail(key, "must configure app-uninstalled provider events.");
      }
      expectEqual(key, "revocation.eventType", app.revocation.eventType, "app/uninstalled");
      expectEqual(key, "revocation.impact", app.revocation.impact, "token");
    },
  },
);
