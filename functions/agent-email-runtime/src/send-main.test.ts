import type { AgentEmailMessageRecord } from "@deployments-ai/agent-email";
import { describe, expect, it } from "bun:test";
import {
  agentEmailClaimOperationLimitFailure,
  agentEmailDispatchLimitFailure,
  agentEmailSendPrerequisiteConditionCheck,
  decodeAgentEmailSendQueueMessage,
  handler,
  handleAgentEmailSendQueue,
  inScope,
  processAgentEmailSend,
  recipientInboxConditionCheck,
  type AgentEmailSendMainDependencies,
  type LoadedAgentEmailSend,
} from "./send-main.ts";

const scope = {
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
  inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
  messageId: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAE",
  type: "agent-email-send" as const,
};

function message(overrides: Partial<AgentEmailMessageRecord> = {}): AgentEmailMessageRecord {
  return {
    attachments: [],
    bccAddresses: [],
    ccAddresses: [],
    createdAt: "2026-07-25T00:00:00.000Z",
    direction: "outbound",
    fromAddress: "agent@example.com",
    id: scope.messageId,
    inboxId: scope.inboxId,
    organizationId: scope.organizationId,
    references: [],
    replyToAddresses: [],
    reprocessCount: 0,
    status: "queued",
    subject: "Hello",
    textBody: "Hello",
    threadKey: "thread",
    toAddresses: ["person@example.net"],
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}

function dependencies(
  value: AgentEmailMessageRecord,
  updates: AgentEmailMessageRecord[],
  activity: { claims: string[]; sends: number } = { claims: [], sends: 0 },
): Omit<AgentEmailSendMainDependencies, "load"> & {
  readonly load: (command: LoadedAgentEmailSend["command"]) => Promise<LoadedAgentEmailSend>;
} {
  return {
    createEventId: () => "01ARZ3NDEKTSV4RRFFQ69G5FAF",
    load: async (command) => ({
      claim: async (claimedAt) => {
        activity.claims.push(claimedAt);
      },
      command,
      kind: "found",
      message: value,
      release: async () => {},
      send: async () => {
        activity.sends += 1;
        return { providerMessageId: "ses-message" };
      },
      update: async (next) => {
        updates.push(next);
      },
    }),
    now: () => new Date("2026-07-25T01:00:00.000Z"),
  };
}

describe("agent email send Lambda", () => {
  it("keeps the Lambda context out of injectable send dependencies", () => {
    expect(handler).not.toBe(handleAgentEmailSendQueue);
    expect(handler.length).toBe(1);
  });

  it("matches canonical environment identity through its resource id", () => {
    const environment = {
      data: {
        id: scope.environmentId,
        organizationId: scope.organizationId,
        projectId: scope.projectId,
      },
      itemType: "environment" as const,
    } as Parameters<typeof inScope>[0];

    expect(inScope(environment, scope)).toBe(true);
    expect(
      inScope(
        {
          ...environment,
          data: { ...environment.data, id: "01ARZ3NDEKTSV4RRFFQ69G5FZZ" },
        } as Parameters<typeof inScope>[0],
        scope,
      ),
    ).toBe(false);
  });

  it("rejects queued work against recipient and attachment limits tightened before dispatch", () => {
    expect(agentEmailDispatchLimitFailure("recipients", 2, 1)).toEqual({
      failureCode: "recipient_limit_exceeded",
      failureReason: "The message exceeds the current policy limit of 1 unique recipients.",
    });
    expect(agentEmailDispatchLimitFailure("attachments", 2, 1)).toEqual({
      failureCode: "attachment_limit_exceeded",
      failureReason: "The message exceeds the current 1-byte attachment policy limit.",
    });
    expect(agentEmailDispatchLimitFailure("recipients", 1, 1)).toBeUndefined();
    expect(agentEmailDispatchLimitFailure("attachments", 1, 1)).toBeUndefined();
  });

  it("reserves generated directory and invariant operations in verified-recipient claims", () => {
    expect(agentEmailClaimOperationLimitFailure(45, 45)).toBeUndefined();
    expect(agentEmailClaimOperationLimitFailure(46, 46)).toEqual({
      failureCode: "recipient_limit_exceeded",
      failureReason:
        "The verified-recipient claim exceeds DynamoDB's 100-operation transaction limit.",
    });
    expect(agentEmailClaimOperationLimitFailure(47, 0)).toBeUndefined();
  });

  it("conditions a terminal policy-limit failure on the policy snapshot", async () => {
    const configured = dependencies(message(), []);
    const prerequisite = {
      conditionExpression: "#data.#version = :version",
      expressionAttributeNames: { "#data": "data", "#version": "version" },
      expressionAttributeValues: { ":version": 3 },
      key: { pk: "policy-pk", sk: "policy-sk" },
      kind: "condition-check" as const,
      table: "control" as const,
    };
    let observedPrerequisites: readonly unknown[] | undefined;

    expect(
      processAgentEmailSend(scope, {
        ...configured,
        load: async (command) => ({
          ...(await configured.load(command)),
          ineligibility: {
            failureCode: "recipient_limit_exceeded",
            failureReason: "The current policy allows only one recipient.",
            prerequisites: [prerequisite],
          },
          update: async (_message, _event, prerequisites) => {
            observedPrerequisites = prerequisites;
          },
        }),
      }),
    ).resolves.toEqual({ disposition: "failed" });
    expect(observedPrerequisites).toEqual([prerequisite]);
  });

  it("locks every loaded send prerequisite to its observed active version", () => {
    expect(
      agentEmailSendPrerequisiteConditionCheck(
        {
          data: { version: 7 },
          pk: "prerequisite-pk",
          sk: "prerequisite-sk",
        },
        "verified",
      ),
    ).toEqual({
      conditionExpression: "#data.#version = :version AND #data.#status = :status",
      expressionAttributeNames: {
        "#data": "data",
        "#status": "status",
        "#version": "version",
      },
      expressionAttributeValues: {
        ":status": "verified",
        ":version": 7,
      },
      key: { pk: "prerequisite-pk", sk: "prerequisite-sk" },
      kind: "condition-check",
      table: "control",
    });
  });

  it("deduplicates the sender inbox prerequisite for a warmup recipient", () => {
    const sender = {
      data: { status: "active" as const, version: 3 },
      itemType: "inbox" as const,
      pk: "inbox-pk",
      sk: "inbox-sk",
    };
    const recipient = {
      ...sender,
      data: { status: "active" as const, version: 5 },
      pk: "recipient-pk",
      sk: "recipient-sk",
    };

    expect(recipientInboxConditionCheck(sender, sender)).toBeUndefined();
    expect(recipientInboxConditionCheck(recipient, sender)).toEqual(
      agentEmailSendPrerequisiteConditionCheck(recipient, "active"),
    );
  });

  it("accepts a sent message and persists the provider identity", async () => {
    const updates: AgentEmailMessageRecord[] = [];
    const activity = { claims: [] as string[], sends: 0 };
    expect(await processAgentEmailSend(scope, dependencies(message(), updates, activity))).toEqual({
      disposition: "accepted",
      providerMessageId: "ses-message",
    });
    expect(activity).toEqual({
      claims: ["2026-07-25T01:00:00.000Z"],
      sends: 1,
    });
    expect(updates).toMatchObject([
      {
        acceptedAt: "2026-07-25T01:00:00.000Z",
        providerMessageId: "ses-message",
        status: "accepted",
      },
    ]);
  });

  it("does not resend a message while another worker holds the send lease", async () => {
    const activity = { claims: [] as string[], sends: 0 };
    expect(
      processAgentEmailSend(
        scope,
        dependencies(
          message({ status: "sending", updatedAt: "2026-07-25T00:59:00.000Z" }),
          [],
          activity,
        ),
      ),
    ).rejects.toThrow("lease is still active");
    expect(activity).toEqual({ claims: [], sends: 0 });
  });

  it("fails an expired unresolved send lease without sending again", async () => {
    const updates: AgentEmailMessageRecord[] = [];
    const activity = { claims: [] as string[], sends: 0 };

    expect(
      processAgentEmailSend(
        scope,
        dependencies(
          message({ status: "sending", updatedAt: "2026-07-25T00:00:00.000Z" }),
          updates,
          activity,
        ),
      ),
    ).resolves.toEqual({ disposition: "failed" });
    expect(activity).toEqual({ claims: [], sends: 0 });
    expect(updates).toMatchObject([
      {
        failureCode: "send_outcome_unknown",
        status: "failed",
      },
    ]);
  });

  it("does not dispatch when the atomic send-policy claim fails", async () => {
    const activity = { claims: [] as string[], sends: 0 };
    const configured = dependencies(message(), [], activity);

    expect(
      processAgentEmailSend(scope, {
        ...configured,
        load: async (command) => ({
          ...(await configured.load(command)),
          claim: async () => {
            throw new Error("Outbound policy was paused before the send claim committed.");
          },
        }),
      }),
    ).rejects.toThrow("policy was paused");
    expect(activity.sends).toBe(0);
  });

  it("acknowledges duplicate queue records for terminal failed messages", async () => {
    const activity = { claims: [] as string[], sends: 0 };
    expect(
      await processAgentEmailSend(scope, dependencies(message({ status: "failed" }), [], activity)),
    ).toEqual({ disposition: "complete" });
    expect(activity).toEqual({ claims: [], sends: 0 });
  });

  it("acks an SES success whose local acceptance write needs provider-event reconciliation", async () => {
    const activity = { claims: [] as string[], sends: 0 };
    const configured = dependencies(message(), [], activity);
    const result = await processAgentEmailSend(scope, {
      ...configured,
      load: async (command) => ({
        ...(await configured.load(command)),
        update: async () => {
          throw new Error("DynamoDB unavailable after SES accepted the message");
        },
      }),
    });

    expect(result).toEqual({
      disposition: "acceptance_pending_reconciliation",
      providerMessageId: "ses-message",
    });
    expect(activity).toEqual({
      claims: ["2026-07-25T01:00:00.000Z"],
      sends: 1,
    });
  });

  it("persists a terminal failed event when SES rejects the send", async () => {
    const updates: AgentEmailMessageRecord[] = [];
    const eventTypes: string[] = [];
    const configured = dependencies(message(), []);
    const result = await processAgentEmailSend(scope, {
      ...configured,
      load: async (command) => {
        const loaded = await configured.load(command);
        return {
          ...loaded,
          send: async () => {
            throw Object.assign(new Error("SES rejected the request"), {
              name: "MessageRejected",
            });
          },
          update: async (next, event) => {
            updates.push(next);
            eventTypes.push(event.eventType);
          },
        };
      },
    });

    expect(result).toEqual({ disposition: "failed" });
    expect(updates).toMatchObject([
      {
        failureCode: "provider_send_failed",
        failureReason: "Amazon SES rejected the outbound message.",
        status: "failed",
      },
    ]);
    expect(eventTypes).toEqual(["agent-email.failed"]);
  });

  it("releases the send lease and retries transient SES failures", async () => {
    const releases: string[] = [];
    const updates: AgentEmailMessageRecord[] = [];
    const configured = dependencies(message(), updates);

    expect(
      processAgentEmailSend(scope, {
        ...configured,
        load: async (command) => {
          const loaded = await configured.load(command);
          return {
            ...loaded,
            release: async (releasedAt) => {
              releases.push(releasedAt);
            },
            send: async () => {
              throw Object.assign(new Error("SES throttled the request"), {
                name: "TooManyRequestsException",
              });
            },
          };
        },
      }),
    ).rejects.toMatchObject({ name: "TooManyRequestsException" });

    expect(releases).toEqual(["2026-07-25T01:00:00.000Z"]);
    expect(updates).toEqual([]);
  });

  it("keeps an ambiguous SES outcome claimed to prevent duplicate delivery", async () => {
    const releases: string[] = [];
    const configured = dependencies(message(), []);

    expect(
      processAgentEmailSend(scope, {
        ...configured,
        load: async (command) => {
          const loaded = await configured.load(command);
          return {
            ...loaded,
            release: async (releasedAt) => {
              releases.push(releasedAt);
            },
            send: async () => {
              throw Object.assign(new Error("The connection closed before the response."), {
                name: "TimeoutError",
              });
            },
          };
        },
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });

    expect(releases).toEqual([]);
  });

  it("leaves future scheduled messages for maintenance", async () => {
    const updates: AgentEmailMessageRecord[] = [];
    expect(
      await processAgentEmailSend(
        scope,
        dependencies(
          message({
            scheduledAt: "2026-07-26T00:00:00.000Z",
            status: "scheduled",
          }),
          updates,
        ),
      ),
    ).toEqual({ disposition: "future" });
    expect(updates).toEqual([]);
  });

  it("terminally fails a due scheduled message that became ineligible", async () => {
    const updates: AgentEmailMessageRecord[] = [];
    const activity = { claims: [] as string[], sends: 0 };
    const configured = dependencies(
      message({
        scheduledAt: "2026-07-25T00:30:00.000Z",
        status: "scheduled",
      }),
      updates,
      activity,
    );
    const ineligible: AgentEmailSendMainDependencies = {
      ...configured,
      load: async (command) => ({
        ...(await configured.load(command)),
        ineligibility: {
          failureCode: "send_policy_inactive",
          failureReason: "The outbound sending policy is no longer active.",
        },
      }),
    };

    expect(processAgentEmailSend(scope, ineligible)).resolves.toEqual({
      disposition: "failed",
    });
    expect(activity).toEqual({ claims: [], sends: 0 });
    expect(updates).toMatchObject([
      {
        failureCode: "send_policy_inactive",
        status: "failed",
      },
    ]);
    expect(
      handleAgentEmailSendQueue(
        {
          Records: [{ body: JSON.stringify(scope), messageId: "scheduled" }],
        },
        ineligible,
      ),
    ).resolves.toEqual({ batchItemFailures: [] });
  });

  it("fails closed on a queued scope mismatch", async () => {
    expect(
      processAgentEmailSend(
        scope,
        dependencies(message({ inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAG" }), []),
      ),
    ).rejects.toThrow("does not match the queued scope");
  });

  it("returns partial SQS batch failures", async () => {
    const result = await handleAgentEmailSendQueue(
      {
        Records: [
          { body: JSON.stringify(scope), messageId: "good" },
          { body: "not-json", messageId: "bad" },
        ],
      },
      dependencies(message(), []),
    );
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "bad" }] });
    expect(decodeAgentEmailSendQueueMessage(JSON.stringify(scope))).toEqual(scope);
  });
});
