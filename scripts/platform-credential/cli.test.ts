import { describe, expect, it } from "bun:test";
import { Ulid } from "@deployments-ai/db";
import { Schema } from "effect";
import { parseCli, usage } from "./cli.ts";

const principalId = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const password = "an-operator-password-from-the-environment";
const apiKeyArgs = [
  "api-key",
  "--api-url",
  "https://api.example.com",
  "--org",
  "01ARZ3NDEKTSV4RRFFQ69G5FAA",
  "--project",
  "01ARZ3NDEKTSV4RRFFQ69G5FAB",
  "--env",
  "01ARZ3NDEKTSV4RRFFQ69G5FAC",
  "--name",
  "reconciler",
  "--scopes",
  "agents:read, agents:write",
  "--secret",
  "/platform/reconciler",
];

describe("parseCli", () => {
  it("prints general and per-command help", () => {
    expect(parseCli([], {})).toEqual({ command: undefined, kind: "help" });
    expect(parseCli(["token", "--help"], {})).toEqual({ command: "token", kind: "help" });
    expect(usage("api-key")).toContain("api-key --api-url <origin>");
    expect(usage("api-key")).not.toContain("identity --principal-id");
  });

  it("reads the identity password from a secret or the environment", () => {
    expect(
      parseCli(
        [
          "identity",
          "--principal-id",
          principalId,
          "--username",
          "Ops@Example.com",
          "--password-secret",
          "/platform/operator",
          "--rotate",
        ],
        {},
      ),
    ).toEqual({
      kind: "identity",
      password: { kind: "secret", secretId: "/platform/operator" },
      principalId,
      rotate: true,
      username: "ops@example.com",
    });
    expect(
      parseCli(["identity", "--principal-id", principalId, "--username", "ops@example.com"], {
        DEPLOYMENTS_OPERATOR_PASSWORD: password,
      }),
    ).toMatchObject({ password: { kind: "environment", password } });
  });

  it("rejects rotation without a password secret", () => {
    expect(() =>
      parseCli(
        ["identity", "--principal-id", principalId, "--username", "ops@example.com", "--rotate"],
        { DEPLOYMENTS_OPERATOR_PASSWORD: password },
      ),
    ).toThrow("--rotate needs --password-secret");
  });

  it("explains a missing or unusable environment password without echoing it", () => {
    const identity = ["identity", "--principal-id", principalId, "--username", "ops@example.com"];
    expect(() => parseCli(identity, {})).toThrow(
      "Pass --password-secret <parameter> or set DEPLOYMENTS_OPERATOR_PASSWORD.",
    );
    const parse = () => parseCli(identity, { DEPLOYMENTS_OPERATOR_PASSWORD: "too-short" });
    expect(parse).toThrow("DEPLOYMENTS_OPERATOR_PASSWORD is not a usable password.");
    expect(parse).not.toThrow("too-short");
  });

  it("validates identifiers and origins", () => {
    expect(() =>
      parseCli(["identity", "--principal-id", "not-a-ulid", "--username", "ops@example.com"], {}),
    ).toThrow("--principal-id must be a canonical uppercase 26-character ULID.");
    expect(() =>
      parseCli(
        [
          "token",
          "--api-url",
          "https://api.example.com/v1",
          "--issuer",
          "https://auth.example.com",
          "--username",
          "ops@example.com",
        ],
        { DEPLOYMENTS_OPERATOR_PASSWORD: password },
      ),
    ).toThrow("--api-url must be an https origin");
    expect(() =>
      parseCli(
        [
          "token",
          "--api-url",
          "http://api.example.com",
          "--issuer",
          "https://auth.example.com",
          "--username",
          "ops@example.com",
        ],
        { DEPLOYMENTS_OPERATOR_PASSWORD: password },
      ),
    ).toThrow("--api-url must be an https origin");
    expect(() => parseCli(["token", "--format", "yaml"], {})).toThrow(
      "--format must be token or json.",
    );
    expect(() => parseCli(["identity", "--password", "inline"], {})).toThrow(
      "Unexpected argument --password.",
    );
  });

  it("parses an api-key command with a minted bearer", () => {
    expect(
      parseCli(
        [...apiKeyArgs, "--issuer", "https://auth.example.com", "--username", "ops@example.com"],
        { DEPLOYMENTS_OPERATOR_PASSWORD: password },
      ),
    ).toMatchObject({
      apiUrl: "https://api.example.com",
      bearer: { kind: "identity", login: { issuer: "https://auth.example.com" } },
      kind: "api-key",
      name: "reconciler",
      rotate: false,
      scopes: ["agents:read", "agents:write"],
      secretId: "/platform/reconciler",
    });
  });

  it("requires exactly one bearer source for api-key", () => {
    expect(() => parseCli(apiKeyArgs, {})).toThrow("api-key needs a bearer");
    expect(() =>
      parseCli([...apiKeyArgs, "--username", "ops@example.com"], {
        DEPLOYMENTS_API_KEY: "dpl_bearer",
      }),
    ).toThrow("DEPLOYMENTS_API_KEY is set, so --username would be ignored");
    expect(parseCli(apiKeyArgs, { DEPLOYMENTS_API_KEY: "dpl_bearer" })).toMatchObject({
      bearer: { key: "dpl_bearer", kind: "api-key" },
    });
  });

  it("rejects scopes that cannot be checked or are malformed", () => {
    const withScopes = (scopes: string) => {
      const args = [...apiKeyArgs];
      args[args.indexOf("--scopes") + 1] = scopes;
      return () => parseCli(args, { DEPLOYMENTS_API_KEY: "dpl_bearer" });
    };
    expect(withScopes("agents:write")).toThrow("--scopes must include a read scope");
    expect(withScopes("agents:read,,agents:write")).toThrow("must not contain empty entries");
    expect(withScopes("agents:read,agents:read")).toThrow("must not repeat a scope");
    expect(withScopes("Agents:Read")).toThrow('invalid scope "Agents:Read"');
  });

  it("takes a Parameter Store path as the secret", () => {
    const withSecret = (secret: string) => {
      const args = [...apiKeyArgs];
      args[args.indexOf("--secret") + 1] = secret;
      return () => parseCli(args, { DEPLOYMENTS_API_KEY: "dpl_bearer" });
    };
    for (const secret of [
      "platform/reconciler",
      "/reconciler",
      "/platform/reconciler/",
      "arn:aws:secretsmanager:us-east-2:123456789012:secret:platform/reconciler-AbCdEf",
    ]) {
      expect(withSecret(secret)).toThrow("--secret must be a Parameter Store path");
    }
  });
});
