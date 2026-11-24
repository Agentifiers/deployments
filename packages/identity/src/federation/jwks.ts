import { createLocalJWKSet, errors, type JSONWebKeySet, type JWTVerifyGetKey } from "jose";

import { FederationError } from "./errors.ts";
import { requestJsonObject, type FederationHttp, type JsonObject } from "./http.ts";

const MAXIMUM_AGE_MILLISECONDS = 10 * 60 * 1_000;
const UNKNOWN_KID_REFETCH_INTERVAL_MILLISECONDS = 60 * 1_000;

interface CachedKeys {
  readonly fetchedAt: number;
  readonly keySet: JWTVerifyGetKey;
}

interface JwksState {
  keys: CachedKeys | undefined;
  loading: Promise<CachedKeys> | undefined;
  lastUnknownKidRefetchAt: number | undefined;
}

export interface FederationJwksCache {
  readonly keyResolver: (jwksUrl: string) => JWTVerifyGetKey;
}

function isJsonWebKeySet(document: JsonObject): document is JsonObject & JSONWebKeySet {
  const { keys } = document;
  return (
    Array.isArray(keys) &&
    keys.every((key: unknown) => typeof key === "object" && key !== null && !Array.isArray(key))
  );
}

export function makeFederationJwksCache(input: {
  readonly http: FederationHttp;
  readonly now: () => Date;
}): FederationJwksCache {
  const states = new Map<string, JwksState>();

  function stateFor(url: string): JwksState {
    const existing = states.get(url);
    if (existing) return existing;
    const created: JwksState = {
      keys: undefined,
      lastUnknownKidRefetchAt: undefined,
      loading: undefined,
    };
    states.set(url, created);
    return created;
  }

  function load(state: JwksState, url: string): Promise<CachedKeys> {
    state.loading ??= (async () => {
      const document = await requestJsonObject({
        failure: "jwks_failed",
        http: input.http,
        request: { headers: { accept: "application/json" }, method: "GET", url },
      });
      if (!isJsonWebKeySet(document)) throw new FederationError("jwks_failed");
      const keys = { fetchedAt: input.now().getTime(), keySet: createLocalJWKSet(document) };
      state.keys = keys;
      return keys;
    })().finally(() => {
      state.loading = undefined;
    });
    return state.loading;
  }

  function current(state: JwksState, url: string): Promise<CachedKeys> {
    const { keys } = state;
    if (keys && input.now().getTime() - keys.fetchedAt < MAXIMUM_AGE_MILLISECONDS) {
      return Promise.resolve(keys);
    }
    return load(state, url);
  }

  function afterUnknownKid(state: JwksState, url: string): Promise<CachedKeys> | undefined {
    if (state.loading) return state.loading;
    const at = input.now().getTime();
    const last = state.lastUnknownKidRefetchAt;
    if (last !== undefined && at - last < UNKNOWN_KID_REFETCH_INTERVAL_MILLISECONDS) {
      return undefined;
    }
    state.lastUnknownKidRefetchAt = at;
    return load(state, url);
  }

  return {
    keyResolver: (url) => async (header, token) => {
      const state = stateFor(url);
      const tried = await current(state, url);
      try {
        return await tried.keySet(header, token);
      } catch (error) {
        if (!(error instanceof errors.JWKSNoMatchingKey)) throw error;
        const refreshed = await afterUnknownKid(state, url);
        if (refreshed === undefined) throw error;
        return refreshed.keySet(header, token);
      }
    },
  };
}
