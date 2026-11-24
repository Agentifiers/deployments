import type { AgentEmailMessageRecord } from "@deployments-ai/agent-email";
import { describe, expect, it } from "bun:test";
import {
  agentEmailProviderSuppressionAddresses,
  handler,
  handleAgentEmailProviderEventsQueue,
  processAgentEmailProviderEvent,
  providerEventEnvironmentMatchesScope,
  type AgentEmailProviderEventsMainDependencies,
  type LoadedAgentEmailProviderEvent,
} from "./provider-events-main.ts";

const normalized = {
  eventType: "DELIVERY",
  internetMessageId: "<outbound@example.com>",
  occurredAt: "2026-07-25T01:00:00.000Z",
  payload: {},
  providerEventId: "provider-event",
  providerMessageId: "ses-message",
  taggedMessageId: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
};

function message(overrides: Partial<AgentEmailMessageRecord> = {}): AgentEmailMessageRecord {
  return {
    attachments: [],
    bccAddresses: [],
    ccAddresses: [],
    createdAt: "2026-07-25T00:00:00.000Z",
    direction: "outbound",
    fromAddress: "agent@example.com",
    id: normalized.taggedMessageId,
    inboxId: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
    organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
    providerMessageId: "ses-message",
    references: [],
    replyToAddresses: [],
    reprocessCount: 0,
    status: "accepted",
    subject: "Hello",
    threadKey: "thread",
    toAddresses: ["person@example.net"],
    updatedAt: "2026-07-25T00:00:00.000Z",
    ...overrides,
  };
}

function dependencies(
  value: AgentEmailMessageRecord,
  updates: AgentEmailMessageRecord[],
  suppress: LoadedAgentEmailProviderEvent["suppress"] = async () => {},
): AgentEmailProviderEventsMainDependencies {
  return {
    load: async (event) => ({
      event,
      kind: "found",
      message: value,
      scope: {
        environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
        organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
        projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAE",
      },
      suppress,
      update: async (next) => {
        updates.push(next);
      },
    }),
  };
}

describe("agent email provider-events Lambda", () => {
  it("keeps the Lambda context out of injectable provider-event dependencies", () => {
    expect(handler).not.toBe(handleAgentEmailProviderEventsQueue);
    expect(handler.length).toBe(1);
  });

  it("accepts late provider callbacks after environment archival", () => {
    expect(
      providerEventEnvironmentMatchesScope(
        {
          data: {
            id: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
            organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
            projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAE",
            status: "archived",
          },
          itemType: "environment",
        },
        {
          environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
          organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
          projectId: "01ARZ3NDEKTSV4RRFFQ69G5FAE",
        },
      ),
    ).toBe(true);
  });

  it("applies a monotonic delivery transition", async () => {
    const updates: AgentEmailMessageRecord[] = [];
    expect(
      await processAgentEmailProviderEvent(normalized, dependencies(message(), updates)),
    ).toEqual({ disposition: "applied", status: "delivered" });
    expect(updates[0]).toMatchObject({
      deliveredAt: normalized.occurredAt,
      internetMessageId: "<outbound@example.com>",
      status: "delivered",
    });
  });

  it("persists matching bounce recipients before applying the message transition", async () => {
    const actions: string[] = [];
    const bounce = {
      ...normalized,
      eventType: "BOUNCE",
      payload: {
        bounce: {
          bounceType: "Permanent",
          bouncedRecipients: [
            { emailAddress: "PERSON@example.net" },
            { emailAddress: "unrelated@example.net" },
          ],
        },
      },
    };
    const source = message({
      ccAddresses: ["copy@example.net"],
      toAddresses: ["person@example.net"],
    });

    expect(agentEmailProviderSuppressionAddresses(bounce, source)).toEqual({
      addresses: ["person@example.net"],
      reason: "bounce",
    });
    expect(
      processAgentEmailProviderEvent(
        bounce,
        dependencies(source, [], async (input) => {
          actions.push("suppress");
          expect(input).toEqual({
            addresses: ["person@example.net"],
            reason: "bounce",
            sourceMessageId: normalized.taggedMessageId,
          });
        }),
      ),
    ).resolves.toEqual({ disposition: "applied", status: "bounced" });
    actions.push("updated");
    expect(actions).toEqual(["suppress", "updated"]);
  });

  it("does not durably suppress a transient bounce recipient", async () => {
    let suppressions = 0;
    expect(
      processAgentEmailProviderEvent(
        {
          ...normalized,
          eventType: "BOUNCE",
          payload: {
            bounce: {
              bounceType: "Transient",
              bouncedRecipients: [{ emailAddress: "person@example.net" }],
            },
          },
        },
        dependencies(message(), [], async () => {
          suppressions += 1;
        }),
      ),
    ).resolves.toEqual({ disposition: "applied", status: "bounced" });
    expect(suppressions).toBe(0);
  });

  it("fails closed when a complaint does not identify a message recipient", async () => {
    expect(
      processAgentEmailProviderEvent(
        {
          ...normalized,
          eventType: "COMPLAINT",
          payload: {
            complaint: {
              complainedRecipients: [{ emailAddress: "unrelated@example.net" }],
            },
          },
        },
        dependencies(message(), []),
      ),
    ).rejects.toThrow("no matching message recipients");
  });

  it("ignores a stale event", async () => {
    expect(
      await processAgentEmailProviderEvent(
        { ...normalized, eventType: "SEND" },
        dependencies(message({ status: "delivered" }), []),
      ),
    ).toEqual({ disposition: "ignored" });
  });

  it("reconciles a late provider event after an unknown send outcome", async () => {
    const updates: AgentEmailMessageRecord[] = [];

    expect(
      processAgentEmailProviderEvent(
        { ...normalized, eventType: "SEND" },
        dependencies(
          message({
            failureCode: "send_outcome_unknown",
            failureReason: "The provider outcome was not observed.",
            status: "failed",
          }),
          updates,
        ),
      ),
    ).resolves.toEqual({ disposition: "applied", status: "accepted" });
    expect(updates).toMatchObject([{ status: "accepted" }]);
    expect(updates[0]).not.toHaveProperty("failureCode");
    expect(updates[0]).not.toHaveProperty("failureReason");
  });

  it("fails closed on a provider message mismatch", async () => {
    expect(
      processAgentEmailProviderEvent(
        normalized,
        dependencies(message({ providerMessageId: "other" }), []),
      ),
    ).rejects.toThrow("does not match");
  });

  it("returns partial SQS batch failures", async () => {
    const body = JSON.stringify({
      eventType: "Delivery",
      delivery: { timestamp: normalized.occurredAt },
      mail: {
        messageId: "ses-message",
        tags: { agentEmailMessageId: [normalized.taggedMessageId] },
      },
    });
    expect(
      await handleAgentEmailProviderEventsQueue(
        {
          Records: [
            { body, messageId: "good" },
            { body: "{}", messageId: "bad" },
          ],
        },
        dependencies(message(), []),
      ),
    ).toEqual({ batchItemFailures: [{ itemIdentifier: "bad" }] });
  });

  it("acknowledges SES event-destination validation notices without failing the batch", async () => {
    const notice = "Successfully validated SNS topic for Amazon SES event publishing.";
    expect(
      await handleAgentEmailProviderEventsQueue(
        {
          Records: [
            { body: notice, messageId: "raw-notice" },
            { body: JSON.stringify({ Message: notice, Type: "Notification" }), messageId: "sns" },
            { body: "Not an SES event.", messageId: "garbage" },
          ],
        },
        dependencies(message(), []),
      ),
    ).toEqual({ batchItemFailures: [{ itemIdentifier: "garbage" }] });
  });
});
