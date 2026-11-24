import { describe, expect, test } from "bun:test";
import { sha256 } from "@deployments-ai/identity";
import {
  appsOAuthClient,
  identityBootstrap,
  needsNewClientSecret,
  parameterName,
} from "./identity-clients.ts";

describe("identity client secrets", () => {
  test("keeps a parameter value that matches the recorded hash", () => {
    expect(needsNewClientSecret({ parameterValue: "copied", recordedHash: sha256("copied") })).toBe(
      false,
    );
  });

  test("issues a new secret when the parameter is missing or does not match", () => {
    expect(needsNewClientSecret({ parameterValue: undefined, recordedHash: sha256("x") })).toBe(
      true,
    );
    expect(needsNewClientSecret({ parameterValue: "other", recordedHash: sha256("x") })).toBe(true);
    expect(needsNewClientSecret({ parameterValue: "x", recordedHash: undefined })).toBe(true);
  });

  test("writes to the parameter name, not the ARN", () => {
    expect(
      parameterName("arn:aws:ssm:us-east-2:123456789012:parameter/identity/web-oauth-client"),
    ).toBe("/identity/web-oauth-client");
    expect(() =>
      parameterName(
        "arn:aws:secretsmanager:us-east-2:123456789012:secret:identity-web-oauth-client",
      ),
    ).toThrow("is not a Parameter Store parameter ARN");
  });
});

describe("agent-built apps OAuth client output", () => {
  const secretArn = "arn:aws:ssm:us-east-2:123456789012:parameter/identity/apps-dev-oauth-client";

  test("decodes the client the apps gateway signs in with", () => {
    expect(
      appsOAuthClient({
        app_runtime: {
          cluster_arn: "arn:aws:rds:us-east-2:123456789012:cluster:apps",
          database_function_name: "apps-database",
          oauth_client: {
            client_id: "deployments-apps",
            redirect_uri: "https://apps.example.com/_platform/auth/callback",
            secret_arn: secretArn,
          },
        },
      }),
    ).toEqual({
      clientId: "deployments-apps",
      redirectUri: "https://apps.example.com/_platform/auth/callback",
      secretArn,
    });
  });

  test("is absent when the root disables apps", () => {
    expect(appsOAuthClient({ app_runtime: null })).toBeUndefined();
    expect(appsOAuthClient({})).toBeUndefined();
  });

  test("rejects a malformed client", () => {
    expect(() =>
      appsOAuthClient({
        app_runtime: { oauth_client: { client_id: "deployments-apps", secret_arn: secretArn } },
      }),
    ).toThrow("OpenTofu output app_runtime.oauth_client.redirect_uri is required.");
    expect(() => appsOAuthClient({ app_runtime: { oauth_client: "deployments-apps" } })).toThrow(
      "OpenTofu output app_runtime.oauth_client must be an object.",
    );
  });
});

describe("operator-declared OAuth clients", () => {
  const secretArn =
    "arn:aws:ssm:us-east-2:123456789012:parameter/identity/operator-tools-oauth-client";
  const outputs = (additionalClients: unknown) => ({
    platform_identity_bootstrap: {
      additional_clients: additionalClients,
      bootstrap_role_arn: "arn:aws:iam::123456789012:role/identity-client-bootstrap",
      cli_redirect_uris: ["http://127.0.0.1/callback"],
      completion_marker_name: "/identity/oauth-clients-bootstrapped",
      publication_ready: true,
      web_client_secret_arn:
        "arn:aws:ssm:us-east-2:123456789012:parameter/identity/web-oauth-client",
      web_redirect_uris: ["https://app.example.com/auth/callback"],
    },
  });

  test("decodes each client with the secret parameter OpenTofu named", () => {
    expect(
      identityBootstrap(
        outputs({
          "operator-tools": {
            allowed_scopes: ["email", "openid", "profile"],
            name: "Operator tools",
            redirect_uris: ["https://tools.example.com/auth/callback"],
            secret_arn: secretArn,
          },
        }),
      )?.additionalClients,
    ).toEqual([
      {
        allowedScopes: ["email", "openid", "profile"],
        clientId: "operator-tools",
        name: "Operator tools",
        redirectUris: ["https://tools.example.com/auth/callback"],
        secretArn,
      },
    ]);
  });

  test("is empty when the root declares none or predates the variable", () => {
    expect(identityBootstrap(outputs({}))?.additionalClients).toEqual([]);
    expect(identityBootstrap(outputs(undefined))?.additionalClients).toEqual([]);
  });

  test("refuses a scope identity does not support before touching any client", () => {
    expect(() =>
      identityBootstrap(
        outputs({
          "operator-tools": {
            allowed_scopes: ["openid", "tenants:everything"],
            name: "Operator tools",
            redirect_uris: ["https://tools.example.com/auth/callback"],
            secret_arn: secretArn,
          },
        }),
      ),
    ).toThrow(
      "platform_identity_additional_clients.operator-tools.allowed_scopes has scopes identity does not support: tenants:everything.",
    );
  });
});
