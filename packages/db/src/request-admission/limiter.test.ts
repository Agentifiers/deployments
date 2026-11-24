import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { describe, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { makeOrganizationRequestLimiterFromEnvironment } from "./limiter.ts";

const environment = {
  AWS_LAMBDA_FUNCTION_NAME: "api",
  DEPLOYMENTS_AI_REQUEST_ADMISSION_TABLE: "request-admission",
};

const LIMITS = {
  activeSandboxes: 8,
  apiRequestBurst: 40,
  apiRequestsPerSecond: 20,
  concurrentRuns: 8,
};

/** Stands in for the caller's connection pool and answers every write as admitted. */
function connectionPool() {
  const targets: string[] = [];
  const requestHandler = {
    handle: async (request: { readonly headers: Readonly<Record<string, string>> }) => {
      targets.push(String(request.headers["x-amz-target"]));
      return {
        response: {
          body: Readable.from([JSON.stringify({ Attributes: { tat: { N: "1" } } })]),
          headers: { "content-type": "application/x-amz-json-1.0" },
          statusCode: 200,
        },
      };
    },
  };
  return { requestHandler, targets };
}

describe("organization request limiter from the environment", () => {
  test("admits through the caller's DynamoDB connection pool", async () => {
    // A client of its own would open a new TLS connection inside the 150 ms admission budget on
    // its first write in every execution environment, so cold starts would fail open.
    const pool = connectionPool();
    const limiter = makeOrganizationRequestLimiterFromEnvironment({
      client: new DynamoDBClient({
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
        region: "us-east-2",
        requestHandler: pool.requestHandler,
      }),
      environment,
    });

    expect(await limiter.admit("01ARZ3NDEKTSV4RRFFQ69G5FAV", LIMITS)).toEqual({
      kind: "admitted",
    });
    expect(pool.targets).toEqual(["DynamoDB_20120810.UpdateItem"]);
  });
});
