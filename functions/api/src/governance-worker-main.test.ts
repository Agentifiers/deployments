import { describe, expect, spyOn, test } from "bun:test";
import { RecordDecodeError } from "@deployments-ai/db";
import { GovernanceError, type GovernanceService } from "@deployments-ai/governance";
import { standingInstallation } from "@deployments-ai/organization-admission/testing";
import {
  governanceFailureMetric,
  operationQueueBatches,
  processGovernanceQueueMessage,
  processGovernanceQueueRecords,
  retentionQueueBatches,
} from "./governance-worker-main.ts";

const noRestamp = async () => ({ outcome: "none" as const, restamped: 0 });

const { repository: standing } = standingInstallation();
const LEGACY_ORGANIZATION_ID = "01J9ZQ5Y5V7Q8R3X2K4M6N8P0C";

describe("governance worker telemetry", () => {
  test("emits an Embedded Metric Format operation failure", () => {
    expect(governanceFailureMetric("governance-worker", "GovernanceError", 123)).toEqual({
      _aws: {
        CloudWatchMetrics: [
          {
            Dimensions: [["FunctionName"]],
            Metrics: [{ Name: "OperationFailures", Unit: "Count" }],
            Namespace: "DeploymentsAI/Governance",
          },
        ],
        Timestamp: 123,
      },
      FailureType: "GovernanceError",
      FunctionName: "governance-worker",
      OperationFailures: 1,
    });
  });

  test("fans scheduled retention out in bounded SQS batches", () => {
    const organizations = Array.from({ length: 23 }, (_, index) => `organization-${index}`);
    const batches = retentionQueueBatches(organizations);

    expect(batches.map((batch) => batch.length)).toEqual([10, 10, 3]);
    expect(
      batches.flatMap((batch) =>
        batch.map((entry) => JSON.parse(entry.MessageBody).organizationId),
      ),
    ).toEqual(organizations);
  });

  test("fans durable operation reconciliation out in bounded SQS batches", () => {
    const operations = Array.from({ length: 12 }, (_, index) => ({
      operationId: `operation-${index}`,
      organizationId: `organization-${index}`,
    }));
    const batches = operationQueueBatches(operations);

    expect(batches.map((batch) => batch.length)).toEqual([10, 2]);
    expect(batches.flatMap((batch) => batch.map((entry) => JSON.parse(entry.MessageBody)))).toEqual(
      operations,
    );
  });

  test("acknowledges a queued operation removed by completed tenant erasure", async () => {
    let existenceChecks = 0;
    const service = {
      getOperation: async () => undefined,
      organizationExists: async () => {
        existenceChecks += 1;
        return false;
      },
      runOperation: async () => {
        throw new GovernanceError("operation_not_found", "Governance operation not found.");
      },
    } as unknown as GovernanceService;

    expect(
      processGovernanceQueueMessage(
        service,
        {
          operationId: "operation-deleted-by-erasure",
          organizationId: "organization-erased",
        },
        standing,
        noRestamp,
      ),
    ).resolves.toBeUndefined();
    expect(existenceChecks).toBe(1);
  });

  test("acknowledges a duplicate delivery while its operation lease is active", async () => {
    const service = {
      getOperation: async () => ({ kind: "tenant-export", status: "running" }),
      runOperation: async () => {
        throw new GovernanceError("operation_not_runnable", "Governance operation is running.");
      },
    } as unknown as GovernanceService;

    expect(
      processGovernanceQueueMessage(
        service,
        {
          operationId: "actively-leased-operation",
          organizationId: "organization-present",
        },
        standing,
        noRestamp,
      ),
    ).resolves.toBeUndefined();
  });

  test("retries a missing operation while its organization still exists", async () => {
    const failure = new GovernanceError("operation_not_found", "Governance operation not found.");
    const service = {
      getOperation: async () => undefined,
      organizationExists: async () => true,
      runOperation: async () => {
        throw failure;
      },
    } as unknown as GovernanceService;

    expect(
      processGovernanceQueueMessage(
        service,
        {
          operationId: "unexpectedly-missing-operation",
          organizationId: "organization-present",
        },
        standing,
        noRestamp,
      ),
    ).rejects.toBe(failure);
  });

  test("logs the error and the job of each failed queue message", async () => {
    const service = {
      runRetention: async () => {
        throw new RecordDecodeError({
          cause: undefined,
          message:
            "DynamoDB governance-tenant-record item keys do not match the registered record payload: gsi1pk, gsi1sk.",
        });
      },
    } as unknown as GovernanceService;
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(
        await processGovernanceQueueRecords(
          service,
          [
            {
              body: JSON.stringify({ kind: "retention", organizationId: LEGACY_ORGANIZATION_ID }),
              messageId: "message-1",
            },
            { body: "not json", messageId: "message-2" },
          ],
          standing,
          noRestamp,
        ),
      ).toEqual({
        batchItemFailures: [{ itemIdentifier: "message-1" }, { itemIdentifier: "message-2" }],
      });
      expect(consoleError.mock.calls).toEqual([
        [
          "Governance queue message failed.",
          {
            error:
              "DynamoDB governance-tenant-record item keys do not match the registered record payload: gsi1pk, gsi1sk.",
            errorType: "RecordDecodeError",
            kind: "retention",
            messageId: "message-1",
            organizationId: LEGACY_ORGANIZATION_ID,
          },
        ],
        [
          "Governance queue message failed.",
          {
            error: 'JSON Parse error: Unexpected identifier "not"',
            errorType: "SyntaxError",
            messageId: "message-2",
          },
        ],
      ]);
    } finally {
      consoleError.mockRestore();
      stderr.mockRestore();
    }
  });

  test("skips retention while the organization is suspended and keeps running its operations", async () => {
    const installation = standingInstallation();
    const ran: string[] = [];
    const service = {
      getOperation: async () => ({ kind: "tenant-export", status: "pending" }),
      runOperation: async (_organizationId: string, operationId: string) => {
        ran.push(operationId);
      },
      runRetention: async () => {
        ran.push("retention");
      },
    } as unknown as GovernanceService;
    const deliver = async () => [
      await processGovernanceQueueRecords(
        service,
        [
          {
            body: JSON.stringify({
              kind: "retention",
              organizationId: installation.organizationId,
            }),
            messageId: "retention",
          },
          {
            body: JSON.stringify({
              operationId: "tenant-export",
              organizationId: installation.organizationId,
            }),
            messageId: "export",
          },
        ],
        installation.repository,
        noRestamp,
      ),
      ran.splice(0),
    ];

    await installation.placeHold("abuse");
    const held = await deliver();
    await installation.releaseHold("abuse");
    const released = await deliver();

    expect([held, released]).toEqual([
      [{ batchItemFailures: [] }, ["tenant-export"]],
      [{ batchItemFailures: [] }, ["retention", "tenant-export"]],
    ]);
  });

  test("leaves a queued tenant erasure pending under an abuse hold and runs it under a manual hold", async () => {
    const installation = standingInstallation();
    const operations = new Map([
      ["tenant-erasure", { kind: "tenant-erasure", status: "pending" }],
      ["tenant-export", { kind: "tenant-export", status: "pending" }],
    ]);
    const ran: string[] = [];
    const service = {
      getOperation: async (_organizationId: string, operationId: string) =>
        operations.get(operationId),
      runOperation: async (_organizationId: string, operationId: string) => {
        ran.push(operationId);
        operations.set(operationId, { ...operations.get(operationId)!, status: "completed" });
      },
    } as unknown as GovernanceService;
    const deliver = async () => ({
      ...(await processGovernanceQueueRecords(
        service,
        [...operations.keys()].map((operationId) => ({
          body: JSON.stringify({ operationId, organizationId: installation.organizationId }),
          messageId: operationId,
        })),
        installation.repository,
        noRestamp,
      )),
      erasure: operations.get("tenant-erasure")!.status,
      ran: ran.splice(0),
    });

    await installation.placeHold("abuse");
    const abuseHeld = await deliver();
    await installation.releaseHold("abuse");
    await installation.placeHold("manual");
    const manualHeld = await deliver();

    expect({ abuseHeld, manualHeld }).toEqual({
      abuseHeld: { batchItemFailures: [], erasure: "pending", ran: ["tenant-export"] },
      manualHeld: {
        batchItemFailures: [],
        erasure: "completed",
        ran: ["tenant-erasure", "tenant-export"],
      },
    });
  });
});
