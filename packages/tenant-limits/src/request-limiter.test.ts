import { describe, expect, test } from "bun:test";
import { decideGcra, gcraParameters } from "./gcra.ts";
import { organizationRateLimitedResponse, organizationRateLimitedResult } from "./problem.ts";
import {
  chargedOrganization,
  makeInMemoryRequestRateStore,
  makeOrganizationRequestLimiter,
  RequestRateStoreUnavailable,
  type RequestRateStore,
} from "./request-limiter.ts";

const LIMITS = {
  activeSandboxes: 8,
  apiRequestBurst: 4,
  apiRequestsPerSecond: 2,
  concurrentRuns: 8,
};
const START_MS = 1_800_000_000_000;

function harness(store: RequestRateStore = makeInMemoryRequestRateStore()) {
  let clock = START_MS;
  let consumes = 0;
  const metrics: unknown[] = [];
  const limiter = makeOrganizationRequestLimiter({
    now: () => clock,
    service: "tenancy-api",
    store: {
      consume: (...args) => {
        consumes += 1;
        return store.consume(...args);
      },
    },
    writeMetric: (line) => metrics.push(JSON.parse(line)),
  });
  return {
    advance: (ms: number) => (clock += ms),
    consumes: () => consumes,
    limiter,
    metrics,
  };
}

describe("GCRA", () => {
  test("derives the emission interval and burst tolerance from the organization limits", () => {
    expect(gcraParameters({ apiRequestBurst: 40, apiRequestsPerSecond: 20 })).toEqual({
      burstToleranceUs: 1_950_000,
      emissionIntervalUs: 50_000,
    });
  });

  test("rejects until the arrival time falls back within the tolerance", () => {
    const parameters = { burstToleranceUs: 1_000_000, emissionIntervalUs: 500_000 };
    expect(decideGcra(undefined, parameters, 10_000_000)).toEqual({
      kind: "admitted",
      theoreticalArrivalUs: 10_500_000,
    });
    expect(decideGcra(11_000_000, parameters, 10_000_000)).toEqual({
      kind: "admitted",
      theoreticalArrivalUs: 11_500_000,
    });
    expect(decideGcra(14_200_000, parameters, 10_000_000)).toEqual({
      kind: "rejected",
      retryAtUs: 13_200_000,
    });
  });
});

describe("organization request limiter", () => {
  test("admits the burst, then limits with the computed Retry-After until one interval passes", async () => {
    const { advance, limiter } = harness();
    const admissions = [];
    for (let request = 0; request < 5; request += 1) {
      admissions.push(await limiter.admit("org-a", LIMITS));
    }

    expect(admissions).toEqual([
      { kind: "admitted" },
      { kind: "admitted" },
      { kind: "admitted" },
      { kind: "admitted" },
      { burst: 4, kind: "limited", ratePerSecond: 2, retryAfterSeconds: 1 },
    ]);
    expect(await limiter.admit("org-b", LIMITS)).toEqual({ kind: "admitted" });
    advance(499);
    expect((await limiter.admit("org-a", LIMITS)).kind).toBe("limited");
    advance(1);
    expect(await limiter.admit("org-a", LIMITS)).toEqual({ kind: "admitted" });
    expect((await limiter.admit("org-a", LIMITS)).kind).toBe("limited");
  });

  test("charges each request against the limits its caller passes", async () => {
    const { limiter } = harness();
    const strict = { ...LIMITS, apiRequestBurst: 1, apiRequestsPerSecond: 1 };

    expect(await limiter.admit("org-a", strict)).toEqual({ kind: "admitted" });
    expect(await limiter.admit("org-a", strict)).toEqual({
      burst: 1,
      kind: "limited",
      ratePerSecond: 1,
      retryAfterSeconds: 1,
    });
  });

  test("never admits more than the burst when one organization's requests arrive concurrently", async () => {
    const { limiter } = harness();

    const admissions = await Promise.all(
      Array.from({ length: 50 }, () => limiter.admit("org-a", LIMITS)),
    );

    expect(admissions.filter((admission) => admission.kind === "admitted").length).toBe(4);
    expect(admissions.filter((admission) => admission.kind === "limited").length).toBe(46);
  });

  test("serves repeat rejections from the deny cache without touching the store", async () => {
    const { advance, consumes, limiter } = harness();
    for (let request = 0; request < 5; request += 1) await limiter.admit("org-a", LIMITS);
    expect(consumes()).toBe(5);

    advance(250);
    expect(await limiter.admit("org-a", LIMITS)).toEqual({
      burst: 4,
      kind: "limited",
      ratePerSecond: 2,
      retryAfterSeconds: 1,
    });
    expect(await limiter.admit("org-a", LIMITS)).toMatchObject({ kind: "limited" });
    expect(consumes()).toBe(5);

    advance(250);
    expect(await limiter.admit("org-a", LIMITS)).toEqual({ kind: "admitted" });
    expect(consumes()).toBe(6);
  });

  test("records each limited request as an ApiRequestsLimited metric", async () => {
    const { limiter, metrics } = harness();
    for (let request = 0; request < 5; request += 1) await limiter.admit("org-a", LIMITS);

    expect(metrics).toEqual([
      {
        _aws: {
          CloudWatchMetrics: [
            {
              Dimensions: [["Service"], []],
              Metrics: [{ Name: "ApiRequestsLimited", Unit: "Count" }],
              Namespace: "DeploymentsAi/TenantLimits",
            },
          ],
          Timestamp: START_MS,
        },
        ApiRequestsLimited: 1,
        Service: "tenancy-api",
        organizationId: "org-a",
        retryAfterSeconds: 1,
      },
    ]);
  });

  test("admits and records LimiterUnavailable when the store fails", async () => {
    const { limiter, metrics } = harness({
      consume: async () => {
        throw new RequestRateStoreUnavailable("The request-admission table timed out.");
      },
    });

    expect(await limiter.admit("org-a", LIMITS)).toEqual({ kind: "admitted" });
    expect(metrics).toEqual([
      {
        _aws: {
          CloudWatchMetrics: [
            {
              Dimensions: [["Service"], []],
              Metrics: [{ Name: "LimiterUnavailable", Unit: "Count" }],
              Namespace: "DeploymentsAi/TenantLimits",
            },
          ],
          Timestamp: START_MS,
        },
        LimiterUnavailable: 1,
        Service: "tenancy-api",
        errorType: "RequestRateStoreUnavailable",
        organizationId: "org-a",
      },
    ]);
  });

  test("charges only identities bound to exactly one organization", () => {
    expect(chargedOrganization(["org-a"])).toBe("org-a");
    expect(chargedOrganization(["org-a", "org-b"])).toBeUndefined();
    expect(chargedOrganization("*")).toBeUndefined();
    expect(chargedOrganization(undefined)).toBeUndefined();
  });
});

describe("organization rate-limited problem", () => {
  const limited = { burst: 100, kind: "limited", ratePerSecond: 50, retryAfterSeconds: 3 } as const;
  const body = {
    type: "https://docs.deployments.ai/errors/organization-rate-limited",
    title: "The organization exceeded its API request rate limit.",
    status: 429,
    code: "organization_rate_limited",
    detail: "This organization is limited to 50 requests per second with a burst of 100.",
    requestId: "req_1",
  };

  test("renders the API Gateway result", () => {
    const result = organizationRateLimitedResult(limited, "req_1");
    expect(JSON.parse(result.body)).toEqual(body);
    expect(result.statusCode).toBe(429);
    expect(result.headers).toEqual({
      "content-type": "application/problem+json",
      "retry-after": "3",
      "x-request-id": "req_1",
    });
  });

  test("renders the fetch Response", async () => {
    const response = organizationRateLimitedResponse(limited, "req_1");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("3");
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(await response.json()).toEqual(body);
  });
});
