import { describe, expect, test } from "bun:test";
import type { ApiIdentity } from "../api-service-contracts.ts";
import { requestFromHttpApiV2Event } from "../lambda.ts";
import { createSystemOperatorApi } from "./api.ts";
import { parseSystemObserverRoles } from "./observer.ts";
import { fakeService, INSTALLATION, OPERATOR_ID } from "./system-operator.fixture.ts";

const OBSERVER_ROLE_ARNS = [
  "arn:aws:iam::123456789012:role/platform-observer",
  " arn:aws:iam::123456789012:role/vendor/ops/install-reader",
  "arn:aws:iam::210987654321:role/foreign-observer",
].join(",");

const ADMINISTRATOR = {
  authentication: "tenant-jwt",
  platformRole: "administrator",
  principalId: OPERATOR_ID,
  scopes: [],
} as const satisfies ApiIdentity;

const SESSION = "arn:aws:sts::123456789012:assumed-role/platform-observer/install-observer";

const FORBIDDEN = {
  body: {
    code: "system_observer_required",
    detail:
      "Observer routes require an assumed-role session of a role in system_observer_role_arns in this install's account.",
    requestId: "request-1",
    status: 403,
    title: "Forbidden",
  },
  status: 403,
};

function api(input: { readonly environment?: NodeJS.ProcessEnv; readonly identity?: ApiIdentity }) {
  return createSystemOperatorApi({
    authenticate: async () => input.identity ?? null,
    observers: parseSystemObserverRoles(
      input.environment ?? {
        DEPLOYMENTS_AI_AWS_ACCOUNT_ID: "123456789012",
        DEPLOYMENTS_AI_SYSTEM_OBSERVER_ROLE_ARNS: OBSERVER_ROLE_ARNS,
      },
    ),
    requestId: () => "request-1",
    service: fakeService({ installation: INSTALLATION }),
    services: { kind: "configured", principals: [] },
  });
}

async function call(
  target: string,
  input: {
    readonly authorizer?: unknown;
    readonly environment?: NodeJS.ProcessEnv;
    readonly identity?: ApiIdentity;
    readonly method?: string;
  } = {},
) {
  const [rawPath = "", rawQueryString] = target.split("?");
  const request = requestFromHttpApiV2Event({
    ...(input.identity ? { headers: { authorization: "Bearer platform.jwt.token" } } : {}),
    rawPath,
    ...(rawQueryString ? { rawQueryString } : {}),
    requestContext: {
      ...(input.authorizer === undefined ? {} : { authorizer: input.authorizer }),
      domainName: "api.example.test",
      http: { method: input.method ?? "GET" },
    },
  });
  const response = await api(input)(request);
  return response && { body: await response.json(), status: response.status };
}

const iam = (userArn: unknown) => ({
  iam: { accessKey: "ASIAEXAMPLE", accountId: "123456789012", userArn },
});

describe("system observer routes", () => {
  test("serve a listed role's session the body of the matching system route", async () => {
    for (const [observerPath, systemPath] of [
      ["/v1/system/observer/installation", "/v1/system/installation"],
      ["/v1/system/observer/deployments", "/v1/system/deployments"],
      ["/v1/system/observer/components", "/v1/system/components"],
      ["/v1/system/observer/alarms?state=ALARM&limit=5", "/v1/system/alarms?state=ALARM&limit=5"],
      ["/v1/system/observer/model-providers", "/v1/system/model-providers"],
    ] as const) {
      const operated = await call(systemPath, { identity: ADMINISTRATOR });
      expect({
        path: observerPath,
        ...(await call(observerPath, { authorizer: iam(SESSION) })),
      }).toEqual({ path: observerPath, body: operated?.body, status: 200 });
    }
    expect(
      await call("/v1/system/observer/installation", { authorizer: iam(SESSION) }),
    ).toMatchObject({ body: { sourceCommit: "1".repeat(40), targetName: "acme-prod" } });
  });

  test("validate query parameters as the system routes do", async () => {
    expect(
      await call("/v1/system/observer/alarms?state=FIRING", { authorizer: iam(SESSION) }),
    ).toEqual({
      body: {
        code: "invalid_state",
        detail: "state must be one of ALARM, INSUFFICIENT_DATA, OK.",
        requestId: "request-1",
        status: 400,
        title: "Bad request",
      },
      status: 400,
    });
  });

  test("admit a role listed with a path by its name", async () => {
    const session = "arn:aws:sts::123456789012:assumed-role/install-reader/install-observer";
    expect(
      (await call("/v1/system/observer/components", { authorizer: iam(session) }))?.status,
    ).toBe(200);
  });

  test.each([
    [
      "a listed role in another account",
      "arn:aws:sts::210987654321:assumed-role/foreign-observer/s",
    ],
    [
      "a listed role name assumed in another account",
      "arn:aws:sts::210987654321:assumed-role/platform-observer/install-observer",
    ],
    ["an unlisted role", "arn:aws:sts::123456789012:assumed-role/Administrator/alice"],
    [
      "a role in another partition",
      "arn:aws-us-gov:sts::123456789012:assumed-role/platform-observer/s",
    ],
    ["an IAM user named like the role", "arn:aws:iam::123456789012:user/platform-observer"],
    [
      "an assumed role without a session",
      "arn:aws:sts::123456789012:assumed-role/platform-observer",
    ],
    ["a bare role name", "platform-observer"],
    ["a non-string caller", 42],
  ] as const)("refuse %s", async (_label, userArn) => {
    expect(await call("/v1/system/observer/installation", { authorizer: iam(userArn) })).toEqual(
      FORBIDDEN,
    );
  });

  test.each([
    ["no authorizer", undefined],
    ["a JWT authorizer", { jwt: { claims: { sub: OPERATOR_ID }, scopes: ["platform:admin"] } }],
  ] as const)("refuse a request with %s", async (_label, authorizer) => {
    expect(await call("/v1/system/observer/installation", { authorizer })).toEqual(FORBIDDEN);
  });

  test("refuse a platform administrator's bearer token that gets past the gateway", async () => {
    expect(await call("/v1/system/observer/installation", { identity: ADMINISTRATOR })).toEqual(
      FORBIDDEN,
    );
  });

  test("refuse every session while system_observer_role_arns is empty", async () => {
    for (const environment of [
      { DEPLOYMENTS_AI_AWS_ACCOUNT_ID: "123456789012" },
      { DEPLOYMENTS_AI_SYSTEM_OBSERVER_ROLE_ARNS: OBSERVER_ROLE_ARNS },
    ]) {
      expect(
        await call("/v1/system/observer/installation", { authorizer: iam(SESSION), environment }),
      ).toEqual(FORBIDDEN);
    }
  });

  test("serve no writes", async () => {
    expect(await call("/v1/system/observer/installation", { method: "POST" })).toEqual(FORBIDDEN);
    expect(
      await call("/v1/system/observer/installation", { authorizer: iam(SESSION), method: "POST" }),
    ).toBeUndefined();
  });

  test("serve no organization data", async () => {
    for (const path of [
      "/v1/system/observer/organizations",
      "/v1/system/observer/organizations/01J0000000000000000000000A/limits",
    ]) {
      expect(await call(path)).toEqual(FORBIDDEN);
      expect(await call(path, { authorizer: iam(SESSION) })).toBeUndefined();
    }
  });

  test("keep IAM sessions off the bearer-authenticated system routes", async () => {
    for (const path of ["/v1/system/installation", "/v1/system/organizations"]) {
      expect(
        await call(path, { authorizer: iam(SESSION), identity: ADMINISTRATOR }),
      ).toBeUndefined();
      expect(
        await call(path, { authorizer: iam("arn:aws:sts::123456789012:assumed-role/x/y") }),
      ).toEqual(FORBIDDEN);
    }
  });
});
