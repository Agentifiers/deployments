import { randomUUID } from "node:crypto";
import {
  ApiCredentialResponse,
  ListApiCredentialsResponse,
  ListServiceAccountsResponse,
  ServiceAccountResponse,
} from "@deployments-ai/api-contract";
import { Schema } from "effect";
import type { ProbeResult } from "./api-key-plan.ts";
import type { Tenancy } from "./cli.ts";

export interface IssuedApiKey {
  readonly credential: ApiCredentialResponse;
  readonly key: string;
}

/** The environment-scoped service account and API key operations the api-key command uses. */
export interface PlatformApi {
  readonly createApiKey: (input: {
    readonly name: string;
    readonly scopes: readonly string[];
    readonly serviceAccountId: string;
  }) => Promise<IssuedApiKey>;
  readonly createServiceAccount: (input: {
    readonly name: string;
    readonly scopes: readonly string[];
  }) => Promise<ServiceAccountResponse>;
  readonly listApiKeys: () => Promise<readonly ApiCredentialResponse[]>;
  readonly listServiceAccounts: () => Promise<readonly ServiceAccountResponse[]>;
  /** Sends one authenticated GET with `key`; 401 and 403 mean the key does not authenticate. */
  readonly probe: (input: { readonly key: string; readonly path: string }) => Promise<ProbeResult>;
  /** Revokes an API key; one that is already gone counts as revoked. */
  readonly revokeApiKey: (id: string) => Promise<void>;
}

const USER_AGENT = "deployments-platform-credential";

/** Decodes a response without echoing it, since an issued-key body carries the key. */
function decode<A>(decodeSync: (value: unknown) => A, value: unknown, label: string): A {
  try {
    return decodeSync(value);
  } catch {
    throw new Error(`Platform API returned an invalid ${label} response.`);
  }
}

async function problemMessage(response: Response, method: string, path: string) {
  const body: unknown = await response.json().catch(() => undefined);
  const field = (name: string) => {
    const value: unknown = body && typeof body === "object" ? Reflect.get(body, name) : undefined;
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const detail = field("detail") ?? field("title");
  return `Platform API ${method} ${path.split("?", 1)[0]} returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`;
}

export function httpPlatformApi(input: {
  readonly apiUrl: string;
  readonly bearer: string;
  readonly tenancy: Tenancy;
}): PlatformApi {
  const tenancyHeaders = {
    "x-deployments-environment": input.tenancy.environmentId,
    "x-deployments-organization": input.tenancy.organizationId,
    "x-deployments-project": input.tenancy.projectId,
  };
  const request = (method: "DELETE" | "GET" | "POST", path: string, body?: unknown) =>
    fetch(new URL(path, input.apiUrl), {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.bearer}`,
        "user-agent": USER_AGENT,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "GET" ? {} : { "idempotency-key": randomUUID() }),
        ...tenancyHeaders,
      },
      method,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  const json = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const response = await request(method, path, body);
    if (!response.ok) throw new Error(await problemMessage(response, method, path));
    const value: unknown = await response.json();
    return value;
  };
  const listAll = async <T>(input: {
    readonly decodePage: (value: unknown) => {
      readonly items: readonly T[];
      readonly nextCursor?: string | null | undefined;
    };
    readonly label: string;
    readonly path: string;
  }) => {
    const items: T[] = [];
    let cursor: string | null | undefined;
    do {
      const query = new URLSearchParams({ limit: "100", ...(cursor ? { cursor } : {}) });
      const page = decode(
        input.decodePage,
        await json("GET", `${input.path}?${query.toString()}`),
        input.label,
      );
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  };
  return {
    createApiKey: async ({ name, scopes, serviceAccountId }) => {
      const body = await json("POST", "/v1/api-keys", { name, scopes, serviceAccountId });
      const key: unknown =
        body && typeof body === "object" ? Reflect.get(body, "secret") : undefined;
      if (typeof key !== "string" || !key.trim()) {
        throw new Error("Platform API did not return the new API key.");
      }
      return {
        credential: decode(Schema.decodeUnknownSync(ApiCredentialResponse), body, "API key"),
        key: key.trim(),
      };
    },
    createServiceAccount: async ({ name, scopes }) =>
      decode(
        Schema.decodeUnknownSync(ServiceAccountResponse),
        await json("POST", "/v1/service-accounts", { name, scopes }),
        "service account",
      ),
    listApiKeys: () =>
      listAll({
        decodePage: Schema.decodeUnknownSync(ListApiCredentialsResponse),
        label: "API key list",
        path: "/v1/api-keys",
      }),
    listServiceAccounts: () =>
      listAll({
        decodePage: Schema.decodeUnknownSync(ListServiceAccountsResponse),
        label: "service account list",
        path: "/v1/service-accounts",
      }),
    probe: async ({ key, path }) => {
      const response = await fetch(new URL(path, input.apiUrl), {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${key}`,
          "user-agent": USER_AGENT,
          ...tenancyHeaders,
        },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      await response.body?.cancel();
      if (response.ok) return { kind: "authenticated" };
      if (response.status === 401 || response.status === 403) return { kind: "rejected" };
      throw new Error(
        `API key check GET ${path.split("?", 1)[0]} returned HTTP ${response.status}.`,
      );
    },
    revokeApiKey: async (id) => {
      const path = `/v1/api-keys/${encodeURIComponent(id)}`;
      const response = await request("DELETE", path);
      if (!response.ok && response.status !== 404) {
        throw new Error(await problemMessage(response, "DELETE", path));
      }
      await response.body?.cancel();
    },
  };
}
