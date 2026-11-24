import { afterAll, beforeAll, expect, test } from "bun:test";
import { handler as administrationHandler } from "./administration-api-main.ts";
import { createApiLambdaHandler } from "./api-lambda-foundation.ts";
import { handler as brainHandler } from "./brain-api-main.ts";
import { handler as budgetHandler } from "./budget-api-main.ts";
import { handler as evaluationHandler } from "./evaluation-api-main.ts";
import { handler as governanceHandler } from "./governance-api-main.ts";
import type { HttpApiV2Event, HttpApiV2Result } from "./lambda.ts";
import { handler as tenancyHandler } from "./lambda-main.ts";
import { handler as observabilityHandler } from "./observability-api-main.ts";
import { handler as systemHandler } from "./system-api-main.ts";

const ENVIRONMENT = {
  DEPLOYMENTS_AI_API_IDEMPOTENCY_KMS_KEY_ARN: "arn:aws:kms:us-east-1:123456789012:key/idempotency",
  DEPLOYMENTS_AI_API_JWT_AUDIENCE: "platform-api",
  DEPLOYMENTS_AI_API_JWT_ISSUER: "https://issuer.example.test",
  DEPLOYMENTS_AI_AWS_ACCOUNT_ID: "123456789012",
  DEPLOYMENTS_AI_ARTIFACT_BUCKET: "artifacts",
  DEPLOYMENTS_AI_ARTIFACT_KMS_KEY_ARN: "arn:aws:kms:us-east-1:123456789012:key/artifacts",
  DEPLOYMENTS_AI_BRAIN_ERASURE_FUNCTION_NAME: "brain-search-erasure",
  DEPLOYMENTS_AI_CREDENTIAL_KMS_KEY_ARN: "arn:aws:kms:us-east-1:123456789012:key/credentials",
  DEPLOYMENTS_AI_GOVERNANCE_BUCKET: "governance",
  DEPLOYMENTS_AI_GOVERNANCE_QUEUE_URL:
    "https://sqs.us-east-1.amazonaws.com/123456789012/governance",
  DEPLOYMENTS_AI_GOVERNANCE_SIGNING_KEY_ARN: "arn:aws:kms:us-east-1:123456789012:key/governance",
  DEPLOYMENTS_AI_MEMORY_ERASURE_FUNCTION_NAME: "memory-erasure",
  DEPLOYMENTS_AI_MEMORY_JWT_AUDIENCE: "memory",
  DEPLOYMENTS_AI_MEMORY_JWT_ISSUER: "https://memory.example.test",
  DEPLOYMENTS_AI_REQUEST_ADMISSION_TABLE: "request-admission",
  DEPLOYMENTS_AI_SYSTEM_OBSERVER_ROLE_ARNS: "arn:aws:iam::123456789012:role/platform-observer",
  DEPLOYMENTS_AI_TENANT_LIMIT_DEFAULTS: JSON.stringify({
    active_sandboxes: 8,
    api_request_burst: 40,
    api_requests_per_second: 20,
    concurrent_runs: 8,
  }),
  PLATFORM_OAUTH_APPS_JSON: "{}",
};
const previousEnvironment = Object.fromEntries(
  Object.keys(ENVIRONMENT).map((name) => [name, process.env[name]]),
);

beforeAll(() => {
  Object.assign(process.env, ENVIRONMENT);
});

afterAll(() => {
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const event = (path: string): HttpApiV2Event => ({
  rawPath: path,
  requestContext: { domainName: "api.example.test", http: { method: "GET" } },
});

function expectTenancyNotFound(result: HttpApiV2Result) {
  const requestId = result.headers["x-request-id"];
  expect(requestId).toMatch(/^req_[0-9a-f-]{36}$/u);
  expect(result).toEqual({
    body: JSON.stringify({
      type: "https://docs.deployments.ai/errors/route-not-found",
      title: "The requested API route does not exist.",
      status: 404,
      code: "route_not_found",
      requestId,
    }),
    headers: {
      "content-length": "204",
      "content-type": "application/problem+json",
      "x-request-id": requestId!,
    },
    isBase64Encoded: false,
    statusCode: 404,
  });
}

test("tenancy answers an unknown route with its 404 problem", async () => {
  expectTenancyNotFound(await tenancyHandler(event("/v1/not-a-route")));
});

test("tenancy serves directory administration while identity federation is unconfigured", async () => {
  const directory = await tenancyHandler(event("/v1/directory"));

  expect([directory.statusCode, JSON.parse(directory.body).code]).toEqual([401, "unauthorized"]);
  expectTenancyNotFound(await tenancyHandler(event("/v1/identity-provider")));
});

test.each([
  ["observability", observabilityHandler, "/v1/observability/unknown/deeper/route"],
  [
    "governance",
    governanceHandler,
    "/v1/organizations/01J9ZQ5Y5V7Q8R3X2K4M6N8P0A/audit-exports/unknown/deeper/route",
  ],
  ["brain", brainHandler, "/v1/brains/unknown/deeper/route"],
  ["evaluations", evaluationHandler, "/v1/evaluation-runs/unknown/deeper/route"],
  ["system", systemHandler, "/v1/system/unknown"],
  ["budget", budgetHandler, "/v1/budgets/unknown/deeper/route"],
  ["administration", administrationHandler, "/v1/providers/unknown/deeper/route"],
] as const)(
  "%s answers a route it does not serve with the tenancy 404",
  async (_, handler, path) => {
    expectTenancyNotFound(await handler(event(path)));
  },
);

test("system admits only a listed role's IAM session on an observer route", async () => {
  const observe = async (userArn: string) => {
    const result = await systemHandler({
      rawPath: "/v1/system/observer/model-providers",
      requestContext: {
        authorizer: { iam: { userArn } },
        domainName: "api.example.test",
        http: { method: "GET" },
      },
    });
    return { body: JSON.parse(result.body), status: result.statusCode };
  };

  expect(
    await observe("arn:aws:sts::123456789012:assumed-role/platform-observer/install-observer"),
  ).toMatchObject({ body: { code: "system_operator_unconfigured" }, status: 503 });
  expect(await observe("arn:aws:sts::123456789012:assumed-role/Administrator/alice")).toMatchObject(
    { body: { code: "system_observer_required" }, status: 403 },
  );
});

test("governance answers its own routes with the tenancy 404 when it is not configured", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import { handler } from ${JSON.stringify(new URL("./governance-api-main.ts", import.meta.url).pathname)};
console.log(JSON.stringify(await handler(${JSON.stringify(
        event("/v1/organizations/01J9ZQ5Y5V7Q8R3X2K4M6N8P0A/retention-policy"),
      )})));`,
    ],
    { env: { PATH: process.env.PATH } },
  );
  expect(child.stderr.toString()).toBe("");
  expectTenancyNotFound(JSON.parse(child.stdout.toString()));
});

test("builds the Lambda runtime once, keeps it after a failed request, and retries a failed build", async () => {
  let builds = 0;
  const handler = createApiLambdaHandler(() => {
    builds += 1;
    if (builds === 1) throw new Error("The first build failed.");
    return async (request) => {
      if (new URL(request.url).pathname === "/v1/budgets/failing") {
        throw new Error("The request failed.");
      }
      return new Response(`runtime ${builds}`);
    };
  });

  expect(handler(event("/v1/budgets"))).rejects.toThrow("The first build failed.");
  expect((await handler(event("/v1/budgets"))).body).toBe("runtime 2");
  expect(handler(event("/v1/budgets/failing"))).rejects.toThrow("The request failed.");
  expect((await handler(event("/v1/budgets"))).body).toBe("runtime 2");
});
