import {
  Ulid,
  makeDirectory,
  makeDynamoDatabase,
  makeIdentityFederationAdministration,
  makeTenancyPersistence,
  makeUniqueClaimRecord,
  tableNamesFromEnvironment,
  uniqueClaimRequirements,
  type Directory,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { humanPrincipalRecord } from "@deployments-ai/db/memory-testing";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import type { TenantLimits } from "@deployments-ai/tenant-limits";
import { Schema } from "effect";
import { createScimApi } from "./scim-api.ts";

const ulid = Schema.decodeUnknownSync(Ulid);
const OWNER = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA0");
const RIVAL = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA1");
export const NOW = "2026-10-08T12:00:00.000Z";
export const SCIM_BASE = "https://api.example.test/scim/v2";

const GENEROUS: TenantLimits = {
  activeSandboxes: 8,
  apiRequestBurst: 1000,
  apiRequestsPerSecond: 1000,
  concurrentRuns: 8,
};

let sequence = 0;

export interface ScimReply {
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly status: number;
}

/**
 * The SCIM family over a real data layer on the fake DynamoDB client. Acme verifies
 * acme.example and Rival verifies rival.example; each directory grants `member` and has a token.
 * `placeHold` suspends Acme.
 */
export async function scimHarness(
  options: {
    readonly limits?: TenantLimits;
    readonly users?: (users: Directory["users"]) => Directory["users"];
  } = {},
) {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  for (const owner of [
    humanPrincipalRecord(OWNER, "owner@acme.example"),
    humanPrincipalRecord(RIVAL, "owner@rival.example"),
  ]) {
    fake.put(tables.control, owner);
    for (const claim of uniqueClaimRequirements(owner)) {
      fake.put(tables.control, makeUniqueClaimRecord(claim, owner.data.createdAt));
    }
  }
  const database = makeDynamoDatabase(fake.client, tables);
  const tenancy = makeTenancyPersistence({ database });
  const federation = makeIdentityFederationAdministration({ database });
  const directory = makeDirectory({ database, now: () => new Date(NOW) });
  const configure = async (principalId: Ulid, name: string, domain: string) => {
    const created = await tenancy.organizations.create({
      body: { name },
      identity: { principalId, scopes: ["platform:*"] },
      idempotencyKey: `scim-organization-${++sequence}`,
      query: {},
      scope: {},
    });
    const administrator = { organizationId: ulid(created.id), principalId };
    const pending = await federation.addLoginDomain(administrator, domain);
    await federation.verifyLoginDomain(administrator, pending.data.id, async () => [
      `deployments-login=${pending.data.verificationToken}`,
    ]);
    await directory.putSettings(administrator, { defaultRole: "member" });
    return {
      organizationId: administrator.organizationId,
      token: (await directory.issueToken(administrator)).secret,
    };
  };
  const acme = await configure(OWNER, "Acme", "acme.example");
  const rival = await configure(RIVAL, "Rival", "rival.example");
  const standing = standingInstallation({
    defaultLimits: options.limits ?? GENEROUS,
    organizationId: acme.organizationId,
  });
  const api = createScimApi({
    directory: { ...directory, users: options.users?.(directory.users) ?? directory.users },
    gate: standing.gate,
  });

  async function scim(
    token: string | undefined,
    method: string,
    path: string,
    init: { readonly body?: string; readonly headers?: Readonly<Record<string, string>> } = {},
  ): Promise<ScimReply> {
    const response = await api(
      new Request(`${SCIM_BASE}${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
        ...(init.body === undefined ? {} : { body: init.body }),
      }),
    );
    if (!response) throw new Error(`The SCIM family declined ${path}.`);
    const text = await response.text();
    return {
      body: text === "" ? undefined : JSON.parse(text),
      headers: Object.fromEntries(response.headers),
      status: response.status,
    };
  }

  /** A SCIM call with a JSON body, as identity providers send it. */
  const send = (token: string, method: string, path: string, body: unknown) =>
    scim(token, method, path, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/scim+json; charset=utf-8" },
    });

  return {
    acmeToken: acme.token,
    advance: standing.advance,
    api,
    fake,
    placeHold: standing.placeHold,
    releaseHold: standing.releaseHold,
    rivalToken: rival.token,
    scim,
    send,
  };
}
