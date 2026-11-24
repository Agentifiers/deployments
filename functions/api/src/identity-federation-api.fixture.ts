import {
  Ulid,
  makeDynamoDatabase,
  makeIdentityFederationAdministration,
  makeTenancyPersistence,
  tableNamesFromEnvironment,
  type OrganizationRole,
} from "@deployments-ai/db";
import { fakeDynamoDocumentClient } from "@deployments-ai/db/dynamo-testing";
import { humanPrincipalRecord } from "@deployments-ai/db/memory-testing";
import type { FederationHttp, FederationHttpResponse } from "@deployments-ai/identity";
import { Schema } from "effect";
import type { ApiIdentity } from "./api-service-contracts.ts";
import {
  createIdentityFederationApi,
  type CreateIdentityFederationApiOptions,
} from "./identity-federation-api.ts";

export const ulid = Schema.decodeUnknownSync(Ulid);
export const OWNER = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA0");
const ADMIN = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA1");
const VIEWER = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA2");
const RIVAL = ulid("01ARZ3NDEKTSV4RRFFQ69G5FA3");
export const OWNER_SESSION = ulid("01ARZ3NDEKTSV4RRFFQ69G5FB0");
export const SECRET = "okta-client-secret-value";

export const okta = {
  clientId: "0oa-client",
  displayName: "Acme Okta",
  issuer: "https://idp.example.com",
  jit: { kind: "enabled", role: "member" },
};

function discoveryHttp(issuersWithoutUserinfo: ReadonlySet<string>): FederationHttp {
  return async (request) => {
    const issuer = request.url.replace("/.well-known/openid-configuration", "");
    if (
      ![
        "https://idp.example.com",
        "https://login.example.org",
        "https://drift.example.com",
      ].includes(issuer)
    ) {
      return { body: "", headers: new Headers(), status: 404 };
    }
    const document = {
      authorization_endpoint: `${issuer}/authorize`,
      issuer: issuer === "https://drift.example.com" ? "https://elsewhere.example.com" : issuer,
      jwks_uri: `${issuer}/keys`,
      response_types_supported: ["code"],
      token_endpoint: `${issuer}/token`,
      ...(issuersWithoutUserinfo.has(issuer) ? {} : { userinfo_endpoint: `${issuer}/userinfo` }),
    };
    return { body: JSON.stringify(document), headers: new Headers(), status: 200 };
  };
}

let sequence = 0;

export async function setup(
  options: {
    readonly features?: CreateIdentityFederationApiOptions["features"];
    readonly federationHttp?: FederationHttp;
  } = {},
) {
  const fake = fakeDynamoDocumentClient();
  const tables = tableNamesFromEnvironment({});
  for (const [principalId, email] of [
    [OWNER, "owner@acme.example"],
    [RIVAL, "owner@rival.example"],
  ] as const) {
    fake.put(tables.control, humanPrincipalRecord(principalId, email));
  }
  const database = makeDynamoDatabase(fake.client, tables);
  const tenancy = makeTenancyPersistence({ database });
  const organization = async (principalId: Ulid, name: string) =>
    ulid(
      (
        await tenancy.organizations.create({
          body: { name },
          identity: { principalId, scopes: ["platform:*"] },
          idempotencyKey: `organization-${++sequence}`,
          query: {},
          scope: {},
        })
      ).id,
    );
  const acme = await organization(OWNER, "Acme");
  const rival = await organization(RIVAL, "Rival");
  const human = (
    principalId: Ulid,
    organizationId: Ulid,
    organizationRole: OrganizationRole,
    tokenSessionId?: Ulid,
  ): ApiIdentity => ({
    authentication: "tenant-jwt",
    organizationIds: [organizationId],
    organizationRole,
    principalId,
    scopes: ["members:read", "members:write"],
    ...(tokenSessionId ? { tokenSessionId } : {}),
  });
  const identities: Readonly<Record<string, ApiIdentity>> = {
    admin: human(ADMIN, acme, "admin"),
    owner: human(OWNER, acme, "owner", OWNER_SESSION),
    rival: human(RIVAL, rival, "owner"),
    viewer: human(VIEWER, acme, "viewer"),
  };
  const txt = new Map<string, string[][]>();
  const dnsTimeouts = new Set<string>();
  const issuersWithoutUserinfo = new Set<string>();
  const served = new Map<string, FederationHttpResponse>();
  const discovery = discoveryHttp(issuersWithoutUserinfo);
  const sealed: { readonly binding: Readonly<Record<string, string>>; readonly value: unknown }[] =
    [];
  const handler = createIdentityFederationApi({
    administration: makeIdentityFederationAdministration({ database }),
    authenticate: async (request) => identities[request.headers.get("authorization") ?? ""] ?? null,
    ...(options.features ? { features: options.features } : {}),
    federationHttp:
      options.federationHttp ?? (async (request) => served.get(request.url) ?? discovery(request)),
    idempotency: { execute: async (input) => input.operation() },
    identityIssuer: "https://auth.example.test/",
    requestId: () => "req-test",
    resolveTxt: async (name) => {
      if (dnsTimeouts.has(name))
        throw Object.assign(new Error(`queryTxt ETIMEOUT ${name}`), { code: "ETIMEOUT" });
      const records = txt.get(name);
      if (!records)
        throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: "ENOTFOUND" });
      return records;
    },
    secrets: {
      encrypt: async (value, binding) => {
        sealed.push({ binding, value });
        return {
          algorithm: "AES-256-GCM",
          authenticationTag: "tag",
          ciphertext: `sealed-${sealed.length}`,
          encryptedDataKey: "data-key",
          encryptionContextHash: "context-hash",
          iv: "iv",
          schemaVersion: 1,
        };
      },
    },
  });
  const send = async (
    caller: string,
    method: string,
    path: string,
    body?: unknown,
    organizationId: string = caller === "rival" ? rival : acme,
  ) => {
    const response = await handler(
      new Request(`https://api.example.test${path}`, {
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          authorization: caller,
          "x-deployments-organization": organizationId,
          ...(method === "GET" ? {} : { "idempotency-key": `key-${++sequence}` }),
        },
        method,
      }),
    );
    if (!response) throw new Error(`No route handled ${method} ${path}`);
    const text = await response.text();
    return { body: JSON.parse(text) as Record<string, any>, status: response.status, text };
  };
  return {
    acme,
    dnsTimeouts,
    fake,
    handler,
    issuersWithoutUserinfo,
    rival,
    sealed,
    send,
    served,
    tables,
    txt,
  };
}
