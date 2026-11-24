import { describe, expect, it } from "bun:test";
import type { ApiCredentialResponse, ServiceAccountResponse } from "@deployments-ai/api-contract";
import { ensureApiKey } from "./api-key-command.ts";
import { apiKey, serviceAccount, storedSecret } from "./api-key.fixture.ts";
import type { PlatformApi } from "./platform-api.ts";
import type { SecretStore, StoredSecret } from "./secrets.ts";

const scopes = ["agents:read", "agents:write"];

/** An in-memory platform and secret store that record every write in order. */
function world(input: {
  readonly accounts?: readonly ServiceAccountResponse[];
  readonly keys?: readonly ApiCredentialResponse[];
  readonly rejected?: (key: string) => boolean;
  readonly secret: StoredSecret;
}) {
  const writes: string[] = [];
  const accounts = [...(input.accounts ?? [])];
  const keys = [...(input.keys ?? [])];
  let secret = input.secret;
  const api: PlatformApi = {
    createApiKey: async ({ name, serviceAccountId }) => {
      const credential = apiKey({ name, serviceAccountId });
      keys.push(credential);
      writes.push(`issue ${credential.id}`);
      return { credential, key: `dpl_${credential.id}_new-key-material` };
    },
    createServiceAccount: async ({ name }) => {
      const account = serviceAccount({ name });
      accounts.push(account);
      writes.push(`create account ${name}`);
      return account;
    },
    listApiKeys: async () => keys,
    listServiceAccounts: async () => accounts,
    probe: async ({ key }) =>
      input.rejected?.(key) ? { kind: "rejected" } : { kind: "authenticated" },
    revokeApiKey: async (id) => {
      writes.push(`revoke ${id}`);
    },
  };
  const secrets: SecretStore = {
    create: async ({ purpose, secretId, value }) => {
      secret = { arn: `arn-${secretId}`, current: { value, versionId: "v1" }, kind: "present" };
      writes.push(`create secret ${purpose}`);
      return { arn: `arn-${secretId}`, versionId: "v1" };
    },
    put: async ({ value }) => {
      if (secret.kind === "missing") throw new Error("missing");
      secret = { ...secret, current: { value, versionId: "v2" } };
      writes.push("put secret");
      return { arn: secret.arn, versionId: "v2" };
    },
    read: async () => secret,
  };
  return { api, secret: () => secret, secrets, writes };
}

const ensure = (
  target: { readonly api: PlatformApi; readonly secrets: SecretStore },
  rotate = false,
) =>
  ensureApiKey({
    api: target.api,
    environmentId: "environment",
    name: "reconciler",
    rotate,
    scopes,
    secretId: "/platform/reconciler",
    secrets: target.secrets,
  });

describe("ensureApiKey", () => {
  it("creates the account, key, and missing secret", async () => {
    const target = world({ secret: { kind: "missing" } });
    const result = await ensure(target);

    expect(result.outcome).toBe("created");
    expect(result.secretArn).toBe("arn-/platform/reconciler");
    expect(target.writes).toEqual([
      "create account reconciler",
      `issue ${result.apiCredentialId}`,
      "create secret environment-api-key",
    ]);
    expect(JSON.stringify(result)).not.toContain("key-material");
  });

  it("keeps a stored key that still authenticates without writing", async () => {
    const account = serviceAccount({ name: "reconciler" });
    const stored = apiKey({ name: "reconciler", serviceAccountId: account.id });
    const target = world({ accounts: [account], keys: [stored], secret: storedSecret(stored) });

    expect(await ensure(target)).toEqual({
      apiCredentialId: stored.id,
      keyPrefix: stored.keyPrefix,
      outcome: "unchanged",
      secretArn: "secret-arn",
      secretVersionId: "stored-version",
      serviceAccountId: account.id,
    });
    expect(target.writes).toEqual([]);
  });

  it("writes the replacement before revoking a stored key that no longer authenticates", async () => {
    const account = serviceAccount({ name: "reconciler" });
    const stored = apiKey({ name: "reconciler", serviceAccountId: account.id });
    const target = world({
      accounts: [account],
      keys: [stored],
      rejected: (key) => key.includes(stored.id),
      secret: storedSecret(stored),
    });
    const result = await ensure(target);

    expect(result.outcome).toBe("rotated");
    expect(target.writes).toEqual([
      `issue ${result.apiCredentialId}`,
      "put secret",
      `revoke ${stored.id}`,
    ]);
  });

  it("rotates on request even when the stored key authenticates", async () => {
    const account = serviceAccount({ name: "reconciler" });
    const stored = apiKey({ name: "reconciler", serviceAccountId: account.id });
    const target = world({ accounts: [account], keys: [stored], secret: storedSecret(stored) });

    expect((await ensure(target, true)).outcome).toBe("rotated");
    expect(target.writes.at(-1)).toBe(`revoke ${stored.id}`);
  });

  it("revokes a new key that fails its check and leaves the secret and stored key alone", async () => {
    const account = serviceAccount({ name: "reconciler" });
    const stored = apiKey({ name: "reconciler", serviceAccountId: account.id });
    const target = world({
      accounts: [account],
      keys: [stored],
      rejected: (key) => key.endsWith("new-key-material"),
      secret: storedSecret(stored),
    });

    const failure = await ensure(target, true).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain("was rejected by GET /v1/agent-definitions; revoked it");
    expect(message).not.toContain("key-material");
    expect(target.writes).toHaveLength(2);
    expect(target.writes[1]).toStartWith("revoke ");
    expect(target.writes[1]).not.toBe(`revoke ${stored.id}`);
    expect(target.secret()).toEqual(storedSecret(stored));
  });
});
