import { describe, expect, test } from "bun:test";
import { setImmediate as afterMicrotasksDrain } from "node:timers/promises";

import type { FederationHttp } from "./http.ts";
import { verifyFederationIdToken } from "./id-token.ts";
import { makeFederationJwksCache, type FederationJwksCache } from "./jwks.ts";
import {
  CLIENT_ID,
  ISSUER,
  NONCE,
  connection,
  failureCode,
  fakeJwksEndpoint,
  jsonResponse,
  recordingHttp,
  signIdToken,
  signingKey,
  type SigningKey,
} from "./testing/fake-identity-provider.ts";

const T0 = new Date("2026-10-08T12:00:00.000Z").getTime();

const first = await signingKey("RS256", "first");
const rotated = await signingKey("ES256", "rotated");
const later = await signingKey("RS256", "later");

function clock() {
  let seconds = 0;
  return {
    now: () => new Date(T0 + seconds * 1_000),
    set: (value: number) => {
      seconds = value;
    },
  };
}

function idTokenAt(key: SigningKey, now: Date) {
  const at = now.getTime() / 1_000;
  return signIdToken(key, {
    aud: CLIENT_ID,
    exp: at + 300,
    iat: at - 10,
    iss: ISSUER,
    nonce: NONCE,
    sub: "subject",
  });
}

function verifyAt(jwks: FederationJwksCache, now: Date, idToken: string) {
  return failureCode(verifyFederationIdToken({ connection, idToken, jwks, nonce: NONCE, now }));
}

async function verifyWith(jwks: FederationJwksCache, now: Date, key: SigningKey) {
  return verifyAt(jwks, now, await idTokenAt(key, now));
}

describe("makeFederationJwksCache", () => {
  test("refetches on an unknown kid at most once per 60 seconds", async () => {
    const time = clock();
    const idp = fakeJwksEndpoint([first]);
    const jwks = makeFederationJwksCache({ http: idp.http, now: time.now });
    const step = async (seconds: number, key: SigningKey) => {
      time.set(seconds);
      const code = await verifyWith(jwks, time.now(), key);
      return { code, keyFetches: idp.requests.length };
    };

    const initial = await step(0, first);
    idp.publish([first, rotated]);
    const afterRotation = await step(10, rotated);
    idp.publish([first, rotated, later]);
    const throttled = await step(20, later);
    const afterInterval = await step(71, later);

    expect([initial, afterRotation, throttled, afterInterval]).toEqual([
      { code: "resolved", keyFetches: 1 },
      { code: "resolved", keyFetches: 2 },
      { code: "id_token_signature_invalid", keyFetches: 2 },
      { code: "resolved", keyFetches: 3 },
    ]);
  });

  test("concurrent cold loads and concurrent unknown-kid misses share one in-flight fetch", async () => {
    const time = clock();
    const idp = fakeJwksEndpoint([first]);
    let gate = Promise.withResolvers<void>();
    const heldHttp: FederationHttp = async (request) => {
      const response = await idp.http(request);
      await gate.promise;
      return response;
    };
    const jwks = makeFederationJwksCache({ http: heldHttp, now: time.now });
    const concurrently = async (idToken: string) => {
      const outcomes = Promise.all([1, 2, 3].map(() => verifyAt(jwks, time.now(), idToken)));
      await afterMicrotasksDrain();
      gate.resolve();
      return { keyFetches: idp.requests.length, outcomes: await outcomes };
    };

    const cold = await concurrently(await idTokenAt(first, time.now()));
    idp.publish([first, rotated]);
    gate = Promise.withResolvers<void>();
    time.set(5);
    const misses = await concurrently(await idTokenAt(rotated, time.now()));

    expect({ cold, misses }).toEqual({
      cold: { keyFetches: 1, outcomes: ["resolved", "resolved", "resolved"] },
      misses: { keyFetches: 2, outcomes: ["resolved", "resolved", "resolved"] },
    });
  });

  test("serves cached keys for 10 minutes, then refetches", async () => {
    const time = clock();
    const idp = fakeJwksEndpoint([first]);
    const jwks = makeFederationJwksCache({ http: idp.http, now: time.now });
    const fetchesAt = async (seconds: number) => {
      time.set(seconds);
      await verifyWith(jwks, time.now(), first);
      return idp.requests.length;
    };

    expect([await fetchesAt(0), await fetchesAt(599), await fetchesAt(600)]).toEqual([1, 1, 2]);
  });

  test("fails with jwks_failed on an error or malformed key set, without caching the failure", async () => {
    const responses = [
      jsonResponse(500, { error: "server_error" }),
      jsonResponse(200, { keys: "not-a-list" }),
      jsonResponse(200, { keys: [first.publicJwk] }),
    ];
    const idp = recordingHttp(() => responses.shift() ?? jsonResponse(404, {}));
    const time = clock();
    const jwks = makeFederationJwksCache({ http: idp.http, now: time.now });

    const outcomes = [
      await verifyWith(jwks, time.now(), first),
      await verifyWith(jwks, time.now(), first),
      await verifyWith(jwks, time.now(), first),
    ];

    expect({ keyFetches: idp.requests.length, outcomes }).toEqual({
      keyFetches: 3,
      outcomes: ["jwks_failed", "jwks_failed", "resolved"],
    });
  });
});
