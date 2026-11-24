import { singleLine } from "../platform-deploy/process.ts";
import {
  afterStoredKeyCheck,
  probePath,
  serviceAccountPlan,
  storedKeyPlan,
} from "./api-key-plan.ts";
import type { PlatformApi } from "./platform-api.ts";
import { type SecretStore, writeSecret } from "./secrets.ts";

export interface ApiKeyResult {
  readonly apiCredentialId: string;
  readonly keyPrefix: string;
  readonly outcome: "created" | "rotated" | "unchanged";
  readonly secretArn: string;
  readonly secretVersionId: string;
  readonly serviceAccountId: string;
}

/**
 * Ensures the named service account and its API key, keeping the key in the secret. A new key
 * must authenticate and reach the secret before the key it replaces is revoked, so consumers of
 * the secret always read a working key.
 */
export async function ensureApiKey(input: {
  readonly api: PlatformApi;
  readonly environmentId: string;
  readonly name: string;
  readonly rotate: boolean;
  readonly scopes: readonly string[];
  readonly secretId: string;
  readonly secrets: SecretStore;
}): Promise<ApiKeyResult> {
  const { api, name, scopes, secretId } = input;
  const path = probePath(scopes);
  if (!path) throw new Error("The scopes include no read scope to check the key with.");
  const secret = await input.secrets.read(secretId);
  const accountPlan = serviceAccountPlan({
    accounts: await api.listServiceAccounts(),
    name,
    scopes,
  });
  const account =
    accountPlan.kind === "use"
      ? accountPlan.account
      : await api.createServiceAccount({ name, scopes });
  const plan = storedKeyPlan({
    credentials: await api.listApiKeys(),
    name,
    rotate: input.rotate,
    scopes,
    secret,
    serviceAccountId: account.id,
  });
  const next =
    plan.kind === "check-stored"
      ? afterStoredKeyCheck({
          probe: await api.probe({ key: plan.stored.key, path }),
          stored: plan.stored,
        })
      : plan;
  if (next.kind === "keep" && plan.kind === "check-stored") {
    return {
      apiCredentialId: plan.stored.credential.id,
      keyPrefix: plan.stored.credential.keyPrefix,
      outcome: "unchanged",
      secretArn: plan.stored.secretArn,
      secretVersionId: plan.stored.secretVersionId,
      serviceAccountId: account.id,
    };
  }
  const replaces = next.kind === "issue" ? next.replaces : undefined;

  const issued = await api.createApiKey({ name, scopes, serviceAccountId: account.id });
  const abandon = async (reason: string): Promise<never> => {
    const revoked = await api.revokeApiKey(issued.credential.id).then(
      () => "revoked it",
      (error: unknown) => `could not revoke it (${singleLine(error)}); revoke it manually`,
    );
    throw new Error(
      `New API key ${issued.credential.id} ${reason}; ${revoked}. Secret ${secretId} is unchanged.`,
    );
  };
  const probe = await api
    .probe({ key: issued.key, path })
    .catch(async (error: unknown) => abandon(`could not be checked: ${singleLine(error)}`));
  if (probe.kind !== "authenticated") await abandon(`was rejected by GET ${path.split("?", 1)[0]}`);
  const written = await writeSecret(input.secrets, {
    description: `Platform API key of service account ${name} in environment ${input.environmentId}.`,
    purpose: "environment-api-key",
    secret,
    secretId,
    value: issued.key,
  }).catch(async (error: unknown) =>
    abandon(`could not be written to the secret: ${singleLine(error)}`),
  );
  if (replaces) {
    await api.revokeApiKey(replaces.id).catch((error: unknown) => {
      throw new Error(
        `Secret ${secretId} now holds API key ${issued.credential.id}, but revoking the replaced key ${replaces.id} failed: ${singleLine(error)}. Revoke it manually.`,
      );
    });
  }
  return {
    apiCredentialId: issued.credential.id,
    keyPrefix: issued.credential.keyPrefix,
    outcome: replaces ? "rotated" : "created",
    secretArn: written.arn,
    secretVersionId: written.versionId,
    serviceAccountId: account.id,
  };
}
