import { describe, expect, test } from "bun:test";
import { streamGatewayConfiguration } from "./config.ts";

const requiredEnvironment = {
  DEPLOYMENTS_AI_DURABLE_STREAMS_AUTH_SECRET_ARN:
    "arn:aws:ssm:us-east-2:123456789012:parameter/durable-streams-auth",
  DEPLOYMENTS_AI_DURABLE_STREAMS_URL: "http://durable-streams.internal",
  DEPLOYMENTS_AI_STREAM_SESSION_SECRET_ARN:
    "arn:aws:ssm:us-east-2:123456789012:parameter/stream-session",
};

function allowedOrigins(value?: string) {
  return streamGatewayConfiguration({
    ...requiredEnvironment,
    ...(value === undefined ? {} : { DEPLOYMENTS_AI_STREAM_GATEWAY_ALLOWED_ORIGINS: value }),
  }).allowedOrigins;
}

describe("stream gateway allowed origins", () => {
  test("parses a comma list of exact origins and treats an empty list as none", () => {
    expect(
      allowedOrigins(
        "https://app.example.com, https://*.preview.example.com,https://console.example.com:8443,http://localhost:3000,http://127.0.0.1:5173,http://[::1]:8080",
      ),
    ).toEqual([
      "https://app.example.com",
      "https://*.preview.example.com",
      "https://console.example.com:8443",
      "http://localhost:3000",
      "http://127.0.0.1:5173",
      "http://[::1]:8080",
    ]);
    expect(allowedOrigins()).toEqual([]);
    expect(allowedOrigins("")).toEqual([]);
    expect(allowedOrigins("  ")).toEqual([]);
  });

  test.each([
    ["a wildcard", "*", "*"],
    ["a wildcard inside a label", "https://t-*.example.com", "https://t-*.example.com"],
    ["a wildcard below the first label", "https://app.*.example.com", "https://app.*.example.com"],
    ["a wildcard over plain http", "http://*.localhost:3000", "http://*.localhost:3000"],
    ["a trailing slash", "https://app.example.com/", "https://app.example.com/"],
    ["a path", "https://app.example.com/console", "https://app.example.com/console"],
    ["an uppercase host", "https://App.example.com", "https://App.example.com"],
    ["plain http on a public host", "http://app.example.com", "http://app.example.com"],
    ["a non-http scheme on a loopback host", "ws://localhost:3000", "ws://localhost:3000"],
    ["an empty entry", "https://app.example.com,", ""],
  ])("rejects %s", (_label, value, rejected) => {
    expect(() => allowedOrigins(value)).toThrow(
      `DEPLOYMENTS_AI_STREAM_GATEWAY_ALLOWED_ORIGINS entries must be exact https origins, https://*.<domain> for one DNS label, or http origins on a loopback host; got "${rejected}".`,
    );
  });
});
