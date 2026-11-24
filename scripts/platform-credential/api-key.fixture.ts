import { ApiCredentialResponse, ServiceAccountResponse } from "@deployments-ai/api-contract";
import { makeIdGenerator } from "@deployments-ai/db";
import { Schema } from "effect";
import type { StoredSecret } from "./secrets.ts";

const ids = makeIdGenerator();
const tenancy = {
  environmentId: ids.generate(),
  organizationId: ids.generate(),
  projectId: ids.generate(),
};
const timestamps = {
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
  version: 1,
};

export function serviceAccount(input: {
  readonly name?: string;
  readonly scopes?: readonly string[];
  readonly status?: "active" | "archived" | "disabled";
}) {
  return Schema.decodeUnknownSync(ServiceAccountResponse)({
    ...timestamps,
    ...tenancy,
    id: ids.generate(),
    name: input.name ?? "other",
    scopes: input.scopes ?? ["agents:read", "agents:write"],
    status: input.status ?? "active",
  });
}

export function apiKey(input: {
  readonly name: string;
  readonly scopes?: readonly string[];
  readonly serviceAccountId: string;
}) {
  return Schema.decodeUnknownSync(ApiCredentialResponse)({
    ...timestamps,
    ...tenancy,
    id: ids.generate(),
    keyPrefix: "dpl_prefix",
    name: input.name,
    scopes: input.scopes ?? ["agents:read", "agents:write"],
    serviceAccountId: input.serviceAccountId,
    status: "active",
  });
}

/** A secret whose current version holds a key for `credential`. */
export function storedSecret(credential: { readonly id: string }): StoredSecret {
  return {
    arn: "secret-arn",
    current: { value: `dpl_${credential.id}_stored-key-material`, versionId: "stored-version" },
    kind: "present",
  };
}
