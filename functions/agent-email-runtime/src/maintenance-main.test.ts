import type { PlatformRecord } from "@deployments-ai/db";
import { describe, expect, it, spyOn } from "bun:test";
import {
  AgentEmailMaintenanceOperationError,
  agentEmailMaintenanceErrorDiagnostic,
  agentEmailMaintenanceLogDiagnostic,
} from "./maintenance-diagnostics.ts";
import {
  agentEmailDueMessageQuery,
  decodeAgentEmailMaintenanceCommand,
  handler,
  handleAgentEmailMaintenance,
  listAgentEmailMaintenanceScopeBatch,
  runAgentEmailMaintenance,
  runAgentEmailMaintenanceSweep,
  type AgentEmailMaintenanceCommand,
  type AgentEmailMaintenanceDependencies,
} from "./maintenance-main.ts";

const command = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
  limit: 25,
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
};

describe("agent email maintenance Lambda", () => {
  it("keeps the Lambda context out of injectable maintenance dependencies", () => {
    expect(handler).not.toBe(handleAgentEmailMaintenance);
    expect(handler.length).toBe(1);
  });

  it("enqueues due sends and purges expired raw objects", async () => {
    const enqueued: string[] = [];
    const dependencies: AgentEmailMaintenanceDependencies = {
      cleanup: async () => ({ cleaned: 3 }),
      enqueue: async (message) => {
        enqueued.push(message.messageId);
      },
      listDue: async () => [
        {
          environmentId: command.environmentId,
          inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
          messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAE",
          organizationId: command.organizationId,
          projectId: command.projectId,
        },
      ],
      listScopes: async () => ({ commit: async () => {}, scopes: [] }),
      now: () => new Date("2026-07-25T01:00:00.000Z"),
      purge: async () => ({ purged: 2 }),
    };
    expect(await runAgentEmailMaintenance(command, dependencies)).toEqual({
      cleaned: 3,
      enqueued: 1,
      purged: 2,
    });
    expect(enqueued).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAE"]);
  });

  it("fails closed when a due message escapes scope", async () => {
    expect(
      runAgentEmailMaintenance(command, {
        cleanup: async () => ({ cleaned: 0 }),
        enqueue: async () => undefined,
        listDue: async () => [
          {
            environmentId: command.environmentId,
            inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
            messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAE",
            organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAF",
            projectId: command.projectId,
          },
        ],
        listScopes: async () => ({ commit: async () => {}, scopes: [] }),
        now: () => new Date("2026-07-25T01:00:00.000Z"),
        purge: async () => ({ purged: 0 }),
      }),
    ).rejects.toThrow("maintenance failed 1 bounded operations");
  });

  it("accepts EventBridge detail envelopes and bounds work", () => {
    expect(decodeAgentEmailMaintenanceCommand({ detail: command })).toEqual(command);
    expect(
      decodeAgentEmailMaintenanceCommand({
        Records: [
          {
            body: JSON.stringify({ limit: 25, scheduledAt: "2026-07-25T01:00:00.000Z" }),
            eventSource: "aws:sqs",
          },
        ],
      }),
    ).toEqual({ limit: 25 });
    expect(() =>
      decodeAgentEmailMaintenanceCommand({
        Records: [{ body: "null", eventSource: "aws:sqs" }],
      }),
    ).toThrow("queue body is invalid");
    expect(decodeAgentEmailMaintenanceCommand({})).toEqual({ limit: 100 });
    expect(() =>
      decodeAgentEmailMaintenanceCommand({
        organizationId: command.organizationId,
      }),
    ).toThrow("must include organizationId, projectId, and environmentId");
    expect(() => decodeAgentEmailMaintenanceCommand({ ...command, limit: 1_001 })).toThrow(
      "between 1 and 1000",
    );
    expect(agentEmailDueMessageQuery(command, "2026-07-25T01:00:00.000Z")).toMatchObject({
      ExpressionAttributeValues: {
        ":from": "INBOX-MESSAGE#scheduled#",
        ":pk": `ENV#${command.environmentId}`,
        ":to": "INBOX-MESSAGE#scheduled#2026-07-25T01%3A00%3A00.000Z#\uffff",
      },
      KeyConditionExpression: "#pk = :pk AND #sk BETWEEN :from AND :to",
      Limit: 25,
    });
  });

  it("sweeps a globally bounded batch of canonical active environment scopes", async () => {
    const scopes = [
      command,
      {
        ...command,
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAE",
      },
    ];
    const listed: string[] = [];
    let committed = false;
    const dependencies: AgentEmailMaintenanceDependencies = {
      cleanup: async () => ({ cleaned: 1 }),
      enqueue: async () => undefined,
      listDue: async (scope) => {
        listed.push(`${scope.environmentId}:${scope.limit}`);
        return [];
      },
      listScopes: async (limit) => ({
        commit: async () => {
          committed = true;
        },
        scopes: scopes.map((scope) => ({ ...scope, limit })),
      }),
      now: () => new Date("2026-07-25T01:00:00.000Z"),
      purge: async () => ({ purged: 1 }),
    };

    expect(await runAgentEmailMaintenanceSweep({ limit: 10 }, dependencies)).toEqual({
      cleaned: 2,
      enqueued: 0,
      purged: 2,
      scopes: 2,
    });
    expect(listed).toEqual(scopes.map((scope) => `${scope.environmentId}:5`));
    expect(committed).toBe(true);
  });

  it("advances the scope cursor when a maintenance scope fails", async () => {
    let committed: readonly AgentEmailMaintenanceCommand[] | undefined;
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        runAgentEmailMaintenanceSweep(
          { limit: 10 },
          {
            cleanup: async () => ({ cleaned: 0 }),
            enqueue: async () => undefined,
            listDue: async () => {
              throw new Error("scheduled send lookup failed");
            },
            listScopes: async () => ({
              commit: async (failedScopes) => {
                committed = failedScopes;
              },
              scopes: [command],
            }),
            now: () => new Date("2026-07-25T01:00:00.000Z"),
            purge: async () => ({ purged: 0 }),
          },
        ),
      ).rejects.toThrow("maintenance sweep failed");
      expect(committed).toEqual([command]);
      expect(consoleError).toHaveBeenCalledWith("Agent email maintenance scope failed.", {
        environmentId: command.environmentId,
        error: {
          errorTypes: ["AggregateError", "AgentEmailMaintenanceOperationError", "Error"],
          operations: ["scheduled-send lookup"],
        },
        organizationId: command.organizationId,
        projectId: command.projectId,
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("bounds nested maintenance error diagnostics", () => {
    let cause: Error = new Error("root cause");
    for (let index = 0; index < 10; index += 1) {
      cause = new Error(`wrapper ${index}`, { cause });
    }
    expect(agentEmailMaintenanceErrorDiagnostic(cause)).toEqual({
      cause: {
        cause: {
          cause: {
            cause: { errorType: "Error" },
            errorType: "Error",
          },
          errorType: "Error",
        },
        errorType: "Error",
      },
      errorType: "Error",
    });
  });

  it("redacts unsafe diagnostics and logs scope failures before cursor commit", async () => {
    const unsafe = Object.assign(new Error("customer subject and body"), {
      $metadata: { httpStatusCode: 403 },
      name: "CustomerSubject123",
    });
    expect(agentEmailMaintenanceErrorDiagnostic(unsafe)).toEqual({
      errorType: "UnknownError",
      providerStatusCode: 403,
    });
    let statusReads = 0;
    const statefulStatus = Object.assign(new Error("not logged"), {
      $metadata: {
        get httpStatusCode() {
          statusReads += 1;
          return statusReads === 1 ? 429 : "customer-secret";
        },
      },
    });
    expect(agentEmailMaintenanceErrorDiagnostic(statefulStatus)).toEqual({
      errorType: "Error",
      providerStatusCode: 429,
    });
    expect(statusReads).toBe(1);

    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        runAgentEmailMaintenanceSweep(
          { limit: 1 },
          {
            cleanup: async () => ({ cleaned: 0 }),
            enqueue: async () => undefined,
            listDue: async () => {
              throw unsafe;
            },
            listScopes: async () => ({
              commit: async () => {
                throw new Error("cursor commit failed");
              },
              scopes: [command],
            }),
            now: () => new Date("2026-07-25T01:00:00.000Z"),
            purge: async () => ({ purged: 0 }),
          },
        ),
      ).rejects.toThrow("cursor commit failed");
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(consoleError.mock.calls[0]?.[1])).not.toContain(
        "customer subject and body",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps diagnostic formatting best-effort for hostile thrown values", () => {
    const hostile = new Proxy(new Error("not logged"), {
      get() {
        throw new Error("hostile getter");
      },
      getPrototypeOf() {
        throw new Error("hostile prototype");
      },
    });
    expect(agentEmailMaintenanceErrorDiagnostic(hostile)).toEqual({
      errorType: "DiagnosticFormattingError",
    });

    const malformedAggregate = new AggregateError([]);
    Object.defineProperty(malformedAggregate, "errors", { value: new Set([new Error("hidden")]) });
    expect(agentEmailMaintenanceErrorDiagnostic(malformedAggregate)).toEqual({
      errorType: "DiagnosticFormattingError",
    });

    const largeAggregate = new AggregateError(
      Array.from({ length: 100 }, () => new Error("redacted")),
    );
    expect(agentEmailMaintenanceErrorDiagnostic(largeAggregate).errors).toHaveLength(20);
    expect(agentEmailMaintenanceLogDiagnostic(largeAggregate)).toEqual({
      errorTypes: ["AggregateError", "Error"],
    });

    const providerFailures = new AggregateError(
      Array.from(
        { length: 20 },
        () =>
          new AgentEmailMaintenanceOperationError(
            "enqueue",
            Object.assign(new Error("redacted"), {
              $metadata: { httpStatusCode: 429 },
              name: "ThrottlingException",
            }),
          ),
      ),
    );
    expect(agentEmailMaintenanceLogDiagnostic(providerFailures)).toEqual({
      errorTypes: ["AggregateError", "AgentEmailMaintenanceOperationError", "ThrottlingException"],
      operations: ["enqueue"],
      providerStatusCodes: [429],
    });

    let nested: Error = new AgentEmailMaintenanceOperationError(
      "raw-object purge",
      Object.assign(new Error("redacted"), {
        $metadata: { httpStatusCode: 503 },
        name: "ServiceUnavailable",
      }),
    );
    for (let depth = 0; depth < 3; depth += 1) {
      nested = new AggregateError(Array.from({ length: 20 }, () => nested));
    }
    const bounded = agentEmailMaintenanceErrorDiagnostic(nested);
    const countNodes = (diagnostic: typeof bounded): number =>
      1 +
      (diagnostic.cause ? countNodes(diagnostic.cause) : 0) +
      (diagnostic.errors?.reduce((count, error) => count + countNodes(error), 0) ?? 0);
    expect(countNodes(bounded)).toBeLessThanOrEqual(101);
    expect(agentEmailMaintenanceLogDiagnostic(nested)).toMatchObject({
      errorTypes: expect.arrayContaining([
        "AggregateError",
        "AgentEmailMaintenanceOperationError",
        "ServiceUnavailable",
      ]),
      operations: ["raw-object purge"],
      providerStatusCodes: [503],
    });
  });

  it("continues cleanup but skips scheduled sends for inactive scopes", async () => {
    const calls: string[] = [];
    const inactive = { ...command, sendEnabled: false };

    expect(
      await runAgentEmailMaintenance(inactive, {
        cleanup: async () => {
          calls.push("cleanup");
          return { cleaned: 1 };
        },
        enqueue: async () => {
          calls.push("enqueue");
        },
        listDue: async () => {
          calls.push("listDue");
          return [];
        },
        listScopes: async () => ({ commit: async () => {}, scopes: [] }),
        now: () => new Date("2026-07-25T01:00:00.000Z"),
        purge: async () => {
          calls.push("purge");
          return { purged: 1 };
        },
      }),
    ).toEqual({ cleaned: 1, enqueued: 0, purged: 1 });
    expect(calls).toEqual(["purge", "cleanup"]);
  });

  it("resumes bounded scope enumeration across active and inactive organizations", async () => {
    const secondEnvironmentId = "01ARZ3NDEKTSV4RRFFQ69G5FAD";
    const secondOrganizationId = "01ARZ3NDEKTSV4RRFFQ69G5FAF";
    const organization = (id: string, status: "active" | "archived" = "active") =>
      ({
        data: { id, status },
        itemType: "organization",
      }) as PlatformRecord;
    const environment = (
      environmentId: string,
      organizationId: string,
      projectId: string,
      status: "active" | "archived" = "active",
    ) =>
      ({
        data: {
          id: environmentId,
          organizationId,
          projectId,
          status,
        },
        itemType: "environment",
      }) as PlatformRecord;
    const query = async (input: {
      readonly ExclusiveStartKey?: Readonly<Record<string, string>>;
      readonly ExpressionAttributeValues: Readonly<Record<string, unknown>>;
      readonly Limit: number;
    }) => {
      expect(input.Limit).toBe(1);
      const partition = input.ExpressionAttributeValues[":pk"];
      if (partition === "GLOBAL#ORGANIZATIONS") {
        return input.ExclusiveStartKey
          ? { items: [organization(secondOrganizationId, "archived")] }
          : {
              items: [organization(command.organizationId)],
              lastEvaluatedKey: {
                gsi1pk: "GLOBAL#ORGANIZATIONS",
                gsi1sk: "org-1",
              },
            };
      }
      if (partition === `ORG#${command.organizationId}`) {
        return input.ExclusiveStartKey
          ? {
              items: [environment(secondEnvironmentId, command.organizationId, command.projectId)],
            }
          : {
              items: [
                environment(command.environmentId, command.organizationId, command.projectId),
              ],
              lastEvaluatedKey: {
                gsi1pk: `ORG#${command.organizationId}`,
                gsi1sk: "environment-1",
              },
            };
      }
      return {
        items: [
          environment(
            "01ARZ3NDEKTSV4RRFFQ69G5FB0",
            secondOrganizationId,
            "01ARZ3NDEKTSV4RRFFQ69G5FB1",
            "archived",
          ),
        ],
      };
    };

    const first = await listAgentEmailMaintenanceScopeBatch(1, undefined, query);
    const second = await listAgentEmailMaintenanceScopeBatch(1, first.cursor, query);
    const third = await listAgentEmailMaintenanceScopeBatch(1, second.cursor, query);

    expect([
      first.scopes[0]?.environmentId,
      second.scopes[0]?.environmentId,
      third.scopes[0]?.environmentId,
    ]).toEqual([command.environmentId, secondEnvironmentId, "01ARZ3NDEKTSV4RRFFQ69G5FB0"]);
    expect([
      first.scopes[0]?.sendEnabled,
      second.scopes[0]?.sendEnabled,
      third.scopes[0]?.sendEnabled,
    ]).toEqual([true, true, false]);
    expect(third.cursor).toBeUndefined();
  });
});
