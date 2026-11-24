import { describe, expect, test } from "bun:test";
import { PlatformApiError } from "../errors.ts";
import { domainCheckable, domainFollowed, domainPolls, domainRecheckSeconds } from "./domains.ts";

const AT = "2026-10-09T12:00:00.000Z";
const problem = (code: "certificate_failed" | "edge_rejected") =>
  ({ code, message: "Recorded.", observedAt: AT }) as const;

const states = {
  unverified: { kind: "unverified" },
  verified: { kind: "verified", problem: null, verifiedAt: AT },
  "verified, edge_rejected": {
    kind: "verified",
    problem: problem("edge_rejected"),
    verifiedAt: AT,
  },
  active: { activatedAt: AT, kind: "active", problem: null, verifiedAt: AT },
  "active, certificate_failed": {
    activatedAt: AT,
    kind: "active",
    problem: problem("certificate_failed"),
    verifiedAt: AT,
  },
} as const;

const each = <T>(read: (state: (typeof states)[keyof typeof states]) => T) =>
  Object.fromEntries(Object.entries(states).map(([label, state]) => [label, read(state)]));

describe("domainPolls", () => {
  test("only an unverified domain repeats its check, once the publisher asked, so DNS caches no early miss", () => {
    expect([
      each((state) => domainPolls(state, false)),
      each((state) => domainPolls(state, true)),
    ]).toEqual([
      {
        active: false,
        "active, certificate_failed": false,
        unverified: false,
        verified: false,
        "verified, edge_rejected": false,
      },
      {
        active: false,
        "active, certificate_failed": false,
        unverified: true,
        verified: false,
        "verified, edge_rejected": false,
      },
    ]);
  });
});

test("Check now shows where a check does work: a TXT lookup, a setup, or a new certificate", () => {
  expect(each(domainCheckable)).toEqual({
    active: false,
    "active, certificate_failed": true,
    unverified: true,
    verified: true,
    "verified, edge_rejected": false,
  });
});

test("the list follows a domain the platform works on, and an unverified one for a reader who cannot check", () => {
  expect([
    each((state) => domainFollowed(state, true)),
    each((state) => domainFollowed(state, false)),
  ]).toEqual([
    {
      active: false,
      "active, certificate_failed": true,
      unverified: false,
      verified: true,
      "verified, edge_rejected": true,
    },
    {
      active: false,
      "active, certificate_failed": true,
      unverified: true,
      verified: true,
      "verified, edge_rejected": true,
    },
  ]);
});

test("a check that failed outside the API backs off, and every back-off stops at 10 minutes", () => {
  const busy = new PlatformApiError("refreshAppDomain", { status: 503, title: "Busy" });
  expect([
    domainRecheckSeconds({ error: new TypeError("fetch failed"), failedChecks: 1 }),
    domainRecheckSeconds({ error: busy, failedChecks: 4 }),
    domainRecheckSeconds({ error: busy, failedChecks: 5 }),
  ]).toEqual([60, 480, 600]);
});

test("a Retry-After past 10 minutes waits 10 minutes, however large it is", () => {
  expect(
    [300, 3_000_000, Number("9".repeat(400))].map((retryAfterSeconds) =>
      domainRecheckSeconds({
        error: new PlatformApiError("refreshAppDomain", {
          retryAfterSeconds,
          status: 503,
          title: "Busy",
        }),
        failedChecks: 1,
      }),
    ),
  ).toEqual([300, 600, 600]);
});
