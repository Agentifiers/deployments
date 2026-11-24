import { describe, expect, test } from "bun:test";
import { ConsoleConfigError, parseConsoleConfig } from "./config.ts";

const valid = {
  CONSOLE_IDENTITY_ISSUER: "https://auth.example.com",
  CONSOLE_IDENTITY_TABLE_NAME: "deployments-dev-identity",
  CONSOLE_PLATFORM_API_URL: "https://api.example.com/",
  CONSOLE_PUBLIC_ORIGIN: "https://app.example.com",
  CONSOLE_SESSION_KMS_KEY_ARN:
    "arn:aws:kms:us-east-1:123456789012:key/0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b",
  CONSOLE_WEB_CLIENT_SECRET_ARN:
    "arn:aws:ssm:us-east-1:123456789012:parameter/identity/web-oauth-client",
};

describe("parseConsoleConfig", () => {
  test("normalizes origins and keeps the issuer verbatim", () => {
    expect(parseConsoleConfig(valid)).toEqual({
      identityIssuer: "https://auth.example.com",
      identityTableName: "deployments-dev-identity",
      platformApiUrl: "https://api.example.com",
      publicOrigin: "https://app.example.com",
      sessionKmsKeyArn: valid.CONSOLE_SESSION_KMS_KEY_ARN,
      webClientSecretArn: valid.CONSOLE_WEB_CLIENT_SECRET_ARN,
    });
  });

  test("accepts HTTP only for loopback hosts", () => {
    expect(
      parseConsoleConfig({ ...valid, CONSOLE_PLATFORM_API_URL: "http://127.0.0.1:8787" })
        .platformApiUrl,
    ).toBe("http://127.0.0.1:8787");
    expect(() =>
      parseConsoleConfig({ ...valid, CONSOLE_PLATFORM_API_URL: "http://api.example.com" }),
    ).toThrow("CONSOLE_PLATFORM_API_URL must use HTTPS");
  });

  test("reads the optional OAuth callback origin", () => {
    expect(
      parseConsoleConfig({ ...valid, CONSOLE_OAUTH_CALLBACK_ORIGIN: "" }).oauthCallbackOrigin,
    ).toBe(undefined);
    expect(
      parseConsoleConfig({
        ...valid,
        CONSOLE_OAUTH_CALLBACK_ORIGIN: "https://abc.execute-api.us-east-2.amazonaws.com",
      }).oauthCallbackOrigin,
    ).toBe("https://abc.execute-api.us-east-2.amazonaws.com");
    expect(() =>
      parseConsoleConfig({
        ...valid,
        CONSOLE_OAUTH_CALLBACK_ORIGIN: "https://abc.execute-api.us-east-2.amazonaws.com/prod",
      }),
    ).toThrow(
      'CONSOLE_OAUTH_CALLBACK_ORIGIN must be an origin without a path; received "https://abc.execute-api.us-east-2.amazonaws.com/prod".',
    );
  });

  test("reads the optional stream gateway and docs origins", () => {
    expect(parseConsoleConfig(valid)).not.toHaveProperty("streamGatewayUrl");
    expect(
      parseConsoleConfig({
        ...valid,
        CONSOLE_DOCS_ORIGIN: "https://docs.example.com/",
        CONSOLE_STREAM_GATEWAY_URL: "https://streams.example.com",
      }),
    ).toMatchObject({
      docsOrigin: "https://docs.example.com",
      streamGatewayUrl: "https://streams.example.com",
    });
    expect(() =>
      parseConsoleConfig({
        ...valid,
        CONSOLE_STREAM_GATEWAY_URL: "https://streams.example.com/v1",
      }),
    ).toThrow("CONSOLE_STREAM_GATEWAY_URL must be an origin without a path");
  });

  test("reports every problem at once", () => {
    try {
      parseConsoleConfig({
        CONSOLE_IDENTITY_ISSUER: "not a url",
        CONSOLE_IDENTITY_TABLE_NAME: valid.CONSOLE_IDENTITY_TABLE_NAME,
        CONSOLE_PUBLIC_ORIGIN: "https://app.example.com/console",
        CONSOLE_SESSION_KMS_KEY_ARN: "key/123",
      });
      throw new Error("expected a configuration error");
    } catch (error) {
      expect(error).toBeInstanceOf(ConsoleConfigError);
      expect((error as ConsoleConfigError).problems).toEqual([
        'CONSOLE_PUBLIC_ORIGIN must be an origin without a path; received "https://app.example.com/console".',
        "CONSOLE_PLATFORM_API_URL is required.",
        'CONSOLE_IDENTITY_ISSUER must be an absolute URL; received "not a url".',
        "CONSOLE_WEB_CLIENT_SECRET_ARN is required.",
        'CONSOLE_SESSION_KMS_KEY_ARN must be a KMS key or alias ARN; received "key/123".',
      ]);
    }
  });
});
