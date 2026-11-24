import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  GetItemCommand,
  ProvisionedThroughputExceededException,
} from "@aws-sdk/client-dynamodb";
import { RequestRateStoreUnavailable } from "@deployments-ai/tenant-limits";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeRequestAdmissionStore } from "./store.ts";

const PARAMETERS = { burstToleranceUs: 1_500_000, emissionIntervalUs: 500_000 };
const NOW_US = 1_800_000_000_000_000;
const CREDENTIALS = { accessKeyId: "local", secretAccessKey: "local" };

describe("request admission store failures", () => {
  test("reports a throttled write as unavailable", async () => {
    const client = new DynamoDBClient({ credentials: CREDENTIALS, region: "us-east-1" });
    client.middlewareStack.add(
      () => async () => {
        throw new ProvisionedThroughputExceededException({
          $metadata: { httpStatusCode: 400 },
          message: "Rate of requests exceeds the allowed throughput.",
        });
      },
      { step: "initialize" },
    );
    const store = makeRequestAdmissionStore({ client, tableName: "request-admission" });

    const failure = await store.consume("org-a", PARAMETERS, NOW_US).catch((cause) => cause);

    expect(failure).toBeInstanceOf(RequestRateStoreUnavailable);
    expect(failure.message).toBe(
      "The request-admission table failed: ProvisionedThroughputExceededException.",
    );
  });

  test("abandons a write that exceeds the request budget", async () => {
    const silent = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    try {
      const store = makeRequestAdmissionStore({
        client: new DynamoDBClient({
          credentials: CREDENTIALS,
          endpoint: `http://127.0.0.1:${silent.port}`,
          maxAttempts: 1,
          region: "us-east-1",
        }),
        requestTimeoutMs: 50,
        tableName: "request-admission",
      });
      const started = performance.now();

      const failure = await store.consume("org-a", PARAMETERS, NOW_US).catch((cause) => cause);

      expect(failure).toBeInstanceOf(RequestRateStoreUnavailable);
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      silent.stop(true);
    }
  });
});

const endpoint = process.env.DYNAMODB_LOCAL_ENDPOINT;

describe.skipIf(!endpoint)("request admission store on DynamoDB Local", () => {
  const client = new DynamoDBClient({
    credentials: CREDENTIALS,
    ...(endpoint ? { endpoint } : {}),
    region: "us-east-1",
  });
  const tableName = `request-admission-${crypto.randomUUID()}`;

  beforeAll(async () => {
    await client.send(
      new CreateTableCommand({
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        TableName: tableName,
      }),
    );
  });

  afterAll(async () => {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  });

  const stored = async (organizationId: string) =>
    (
      await client.send(
        new GetItemCommand({
          ConsistentRead: true,
          Key: { pk: { S: `ORG#${organizationId}` } },
          TableName: tableName,
        }),
      )
    ).Item;

  test("admits the burst, rejects with the next arrival time, and restarts an idle window", async () => {
    const store = makeRequestAdmissionStore({ client, tableName });
    const decisions = [];
    for (let request = 0; request < 5; request += 1) {
      decisions.push(await store.consume("org-sequential", PARAMETERS, NOW_US));
    }

    expect(decisions).toEqual([
      { kind: "admitted" },
      { kind: "admitted" },
      { kind: "admitted" },
      { kind: "admitted" },
      { kind: "rejected", retryAtUs: NOW_US + 500_000 },
    ]);
    expect(await stored("org-sequential")).toEqual({
      pk: { S: "ORG#org-sequential" },
      tat: { N: String(NOW_US + 2_000_000) },
      ttl: { N: String(1_800_000_000 + 2 + 3_600) },
    });

    const later = NOW_US + 60_000_000;
    expect(await store.consume("org-sequential", PARAMETERS, later)).toEqual({ kind: "admitted" });
    expect((await stored("org-sequential"))?.tat).toEqual({ N: String(later + 500_000) });
  });

  test("never admits more than the burst across concurrent writers", async () => {
    const decisions = await Promise.all(
      Array.from({ length: 40 }, () =>
        makeRequestAdmissionStore({ client, requestTimeoutMs: 5_000, tableName }).consume(
          "org-concurrent",
          PARAMETERS,
          NOW_US,
        ),
      ),
    );

    expect(decisions.filter((decision) => decision.kind === "admitted").length).toBe(4);
    expect(decisions.filter((decision) => decision.kind === "rejected").length).toBe(36);
    expect((await stored("org-concurrent"))?.tat).toEqual({ N: String(NOW_US + 2_000_000) });
  });
});
