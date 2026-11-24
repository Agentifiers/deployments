import { describe, expect, it } from "bun:test";
import {
  afterStoredKeyCheck,
  probePath,
  serviceAccountPlan,
  storedKeyPlan,
} from "./api-key-plan.ts";
import { apiKey, serviceAccount, storedSecret } from "./api-key.fixture.ts";

const scopes = ["agents:read", "agents:write"];

describe("service account plan", () => {
  it("creates the account when no active account has the name", () => {
    expect(
      serviceAccountPlan({
        accounts: [serviceAccount({ name: "reconciler", status: "archived" })],
        name: "reconciler",
        scopes,
      }),
    ).toEqual({ kind: "create" });
  });

  it("uses the active account with exactly the requested scopes", () => {
    const account = serviceAccount({ name: "reconciler", scopes: ["agents:write", "agents:read"] });
    expect(serviceAccountPlan({ accounts: [account], name: "reconciler", scopes })).toEqual({
      account,
      kind: "use",
    });
  });

  it("refuses to widen an existing account", () => {
    expect(() =>
      serviceAccountPlan({
        accounts: [serviceAccount({ name: "reconciler", scopes: ["agents:read"] })],
        name: "reconciler",
        scopes,
      }),
    ).toThrow("refusing to change them");
  });

  it("rejects ambiguous active accounts", () => {
    expect(() =>
      serviceAccountPlan({
        accounts: [serviceAccount({ name: "reconciler" }), serviceAccount({ name: "reconciler" })],
        name: "reconciler",
        scopes,
      }),
    ).toThrow('Multiple active service accounts are named "reconciler"');
  });
});

describe("stored key plan", () => {
  const account = serviceAccount({ name: "reconciler" });
  const stored = apiKey({ name: "reconciler", serviceAccountId: account.id });
  const plan = (input: Partial<Parameters<typeof storedKeyPlan>[0]>) =>
    storedKeyPlan({
      credentials: [stored],
      name: "reconciler",
      rotate: false,
      scopes,
      secret: storedSecret(stored),
      serviceAccountId: account.id,
      ...input,
    });

  it("issues a first key when the secret is missing or empty", () => {
    expect(plan({ secret: { kind: "missing" } })).toEqual({ kind: "issue", replaces: undefined });
    expect(plan({ secret: { arn: "secret-arn", current: undefined, kind: "present" } })).toEqual({
      kind: "issue",
      replaces: undefined,
    });
  });

  it("checks the stored key when it is this account's active key with the same scopes", () => {
    expect(plan({})).toEqual({
      kind: "check-stored",
      stored: {
        credential: stored,
        key: `dpl_${stored.id}_stored-key-material`,
        secretArn: "secret-arn",
        secretVersionId: "stored-version",
      },
    });
  });

  it("replaces a stored key that is revoked or unknown without revoking anything", () => {
    expect(plan({ credentials: [{ ...stored, status: "revoked" }] })).toEqual({
      kind: "issue",
      replaces: undefined,
    });
    expect(plan({ credentials: [] })).toEqual({ kind: "issue", replaces: undefined });
  });

  it("rotates the stored key on request and revokes it afterwards", () => {
    expect(plan({ rotate: true })).toEqual({ kind: "issue", replaces: stored });
  });

  it("refuses to overwrite another service account's active key", () => {
    const foreign = apiKey({ name: "reconciler", serviceAccountId: serviceAccount({}).id });
    expect(() => plan({ credentials: [foreign], secret: storedSecret(foreign) })).toThrow(
      "refusing to replace another service account's key",
    );
  });

  it("refuses to widen a stored key", () => {
    expect(() => plan({ credentials: [{ ...stored, scopes: ["agents:read"] }] })).toThrow(
      "has different scopes; refusing to change them",
    );
  });

  it("keeps a stored key that authenticates and replaces one that is rejected", () => {
    const check = plan({});
    if (check.kind !== "check-stored") throw new Error("expected a stored key check");
    expect(afterStoredKeyCheck({ probe: { kind: "authenticated" }, stored: check.stored })).toEqual(
      { kind: "keep" },
    );
    expect(afterStoredKeyCheck({ probe: { kind: "rejected" }, stored: check.stored })).toEqual({
      kind: "issue",
      replaces: stored,
    });
  });
});

describe("probe path", () => {
  it("uses the provider's scope order", () => {
    expect(probePath(["webhooks:read", "agents:read"])).toBe("/v1/agent-definitions?limit=1");
    expect(probePath(["agents:write"])).toBeUndefined();
  });
});
