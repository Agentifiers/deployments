import { describe, expect, it } from "bun:test";
import { validatePasswordInput } from "@deployments-ai/identity";
import {
  generateOperatorPassword,
  passwordSecretAction,
  storedPassword,
} from "./password-source.ts";
import type { StoredSecret } from "./secrets.ts";

const secretId = "/platform/operator-password";
const holding = (value: string): StoredSecret => ({
  arn: "secret-arn",
  current: { value, versionId: "v1" },
  kind: "present",
});

describe("password secret action", () => {
  it("generates a password for a missing or empty secret", () => {
    expect(passwordSecretAction({ rotate: false, secret: { kind: "missing" }, secretId })).toEqual({
      kind: "generate",
    });
    expect(
      passwordSecretAction({
        rotate: false,
        secret: { arn: "secret-arn", current: undefined, kind: "present" },
        secretId,
      }),
    ).toEqual({ kind: "generate" });
  });

  it("uses the stored password unless rotation is requested", () => {
    const secret = holding("a-stored-operator-password");
    expect(passwordSecretAction({ rotate: false, secret, secretId })).toEqual({
      kind: "use",
      password: "a-stored-operator-password",
    });
    expect(passwordSecretAction({ rotate: true, secret, secretId })).toEqual({ kind: "generate" });
  });

  it("rejects an unusable stored password without echoing it", () => {
    const action = () =>
      passwordSecretAction({ rotate: false, secret: holding("short"), secretId });
    expect(action).toThrow(`Secret ${secretId} does not hold a usable password`);
    expect(action).not.toThrow("short");
  });
});

describe("stored password", () => {
  it("requires the identity command to have populated the secret", () => {
    expect(() => storedPassword({ secret: { kind: "missing" }, secretId })).toThrow(
      "run identity with --password-secret first",
    );
    expect(storedPassword({ secret: holding("a-stored-operator-password"), secretId })).toBe(
      "a-stored-operator-password",
    );
  });
});

describe("generated operator password", () => {
  it("passes identity validation and differs every time", () => {
    const first = generateOperatorPassword();
    expect(() => validatePasswordInput(first)).not.toThrow();
    expect(generateOperatorPassword()).not.toBe(first);
  });
});
