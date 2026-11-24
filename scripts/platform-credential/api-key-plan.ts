import type { ApiCredentialResponse, ServiceAccountResponse } from "@deployments-ai/api-contract";
import type { StoredSecret } from "./secrets.ts";

/**
 * The read request that proves a key authenticates, chosen by the first scope it holds. The
 * OpenTofu provider (`deployments_environment_credential`) uses the same table.
 */
const PROBES: readonly (readonly [scope: string, path: string])[] = [
  ["approvals:read", "/v1/approvals?limit=1"],
  ["agents:read", "/v1/agent-definitions?limit=1"],
  ["channels:read", "/v1/channel-bindings?limit=1"],
  ["workspaces:read", "/v1/workspaces?limit=1"],
  ["tools:read", "/v1/extensions?limit=1"],
  ["schedules:read", "/v1/schedules?limit=1"],
  ["webhooks:read", "/v1/webhooks?limit=1"],
];

export function probePath(scopes: readonly string[]) {
  return PROBES.find(([scope]) => scopes.includes(scope))?.[1];
}

function sameScopes(actual: readonly string[], expected: readonly string[]) {
  return actual.length === expected.length && expected.every((scope) => actual.includes(scope));
}

export type ServiceAccountPlan =
  | { readonly kind: "create" }
  | { readonly account: ServiceAccountResponse; readonly kind: "use" };

/** Finds the one active service account named `name`; never widens or narrows its scopes. */
export function serviceAccountPlan(input: {
  readonly accounts: readonly ServiceAccountResponse[];
  readonly name: string;
  readonly scopes: readonly string[];
}): ServiceAccountPlan {
  const named = input.accounts.filter(
    (account) => account.name === input.name && account.status === "active",
  );
  const [only] = named;
  if (!only) return { kind: "create" };
  if (named.length === 1) {
    if (!sameScopes(only.scopes, input.scopes)) {
      throw new Error(
        `Service account "${input.name}" (${only.id}) has different scopes; refusing to change them.`,
      );
    }
    return { account: only, kind: "use" };
  }
  const scoped = named.filter((account) => sameScopes(account.scopes, input.scopes));
  const [match] = scoped;
  if (scoped.length !== 1 || !match) {
    throw new Error(`Multiple active service accounts are named "${input.name}".`);
  }
  return { account: match, kind: "use" };
}

/** A key that may stay, with the secret version that holds it. */
export interface StoredKey {
  readonly credential: ApiCredentialResponse;
  readonly key: string;
  readonly secretArn: string;
  readonly secretVersionId: string;
}

export type StoredKeyPlan =
  | { readonly kind: "check-stored"; readonly stored: StoredKey }
  | { readonly kind: "issue"; readonly replaces: ApiCredentialResponse | undefined };

/**
 * Decides whether the key in the secret may stay. A stored key stays only while it is the active
 * key of this service account, named `name`, with exactly `scopes`; it still has to pass the
 * authentication check. `replaces` is the stored key to revoke once its successor is in the
 * secret. A secret that holds another service account's active key is never overwritten.
 */
export function storedKeyPlan(input: {
  readonly credentials: readonly ApiCredentialResponse[];
  readonly name: string;
  readonly rotate: boolean;
  readonly scopes: readonly string[];
  readonly secret: StoredSecret;
  readonly serviceAccountId: string;
}): StoredKeyPlan {
  const current = input.secret.kind === "present" ? input.secret.current : undefined;
  // Platform API keys embed their credential ID: `dpl_<id>_<secret>`.
  const storedId = current?.value.match(/^dpl_([0-7][0-9A-HJKMNP-TV-Z]{25})_/u)?.[1];
  const credential = storedId
    ? input.credentials.find((candidate) => candidate.id === storedId)
    : undefined;
  if (input.secret.kind !== "present" || !current || credential?.status !== "active") {
    return { kind: "issue", replaces: undefined };
  }
  if (credential.serviceAccountId !== input.serviceAccountId) {
    throw new Error(
      `The secret holds active API key ${credential.id} of service account ${credential.serviceAccountId}; refusing to replace another service account's key.`,
    );
  }
  if (!sameScopes(credential.scopes, input.scopes)) {
    throw new Error(
      `The stored API key ${credential.id} has different scopes; refusing to change them.`,
    );
  }
  if (input.rotate || credential.name !== input.name) {
    return { kind: "issue", replaces: credential };
  }
  return {
    kind: "check-stored",
    stored: {
      credential,
      key: current.value,
      secretArn: input.secret.arn,
      secretVersionId: current.versionId,
    },
  };
}

/** How the platform answered a key's authentication check. */
export type ProbeResult = { readonly kind: "authenticated" } | { readonly kind: "rejected" };

/** A stored key that no longer authenticates is replaced, then revoked. */
export function afterStoredKeyCheck(input: {
  readonly probe: ProbeResult;
  readonly stored: StoredKey;
}): Exclude<StoredKeyPlan, { readonly kind: "check-stored" }> | { readonly kind: "keep" } {
  return input.probe.kind === "authenticated"
    ? { kind: "keep" }
    : { kind: "issue", replaces: input.stored.credential };
}
