import { describe, expect, it } from "bun:test";
import {
  createAwsAgentEmailStreamDispatcher,
  handler,
  handleAgentEmailStream,
  makeAgentEmailStreamDispatcher,
} from "./stream-dispatcher-main.ts";

describe("agent email stream-dispatcher Lambda", () => {
  it("keeps the Lambda context out of the injectable dispatcher", () => {
    expect(handler).not.toBe(handleAgentEmailStream);
    expect(handler.length).toBe(1);
  });

  it("delegates DynamoDB batches to the canonical dispatcher", async () => {
    const event = {
      Records: [
        {
          dynamodb: { SequenceNumber: "42" },
          eventID: "event",
          eventName: "INSERT",
        },
      ],
    };
    expect(
      await handleAgentEmailStream(event, async (received) => {
        expect(received).toBe(event);
        return { batchItemFailures: [{ itemIdentifier: "42" }] };
      }),
    ).toEqual({ batchItemFailures: [{ itemIdentifier: "42" }] });
  });

  it("requires an explicit send queue", () => {
    expect(() => createAwsAgentEmailStreamDispatcher({})).toThrow(
      "DEPLOYMENTS_AI_AGENT_EMAIL_SEND_QUEUE_URL is required",
    );
  });

  it("uses DynamoDB sequence numbers when queue delivery fails", async () => {
    let queuedBody: string | undefined;
    const dispatcher = makeAgentEmailStreamDispatcher(
      {
        send: async (command: { readonly input?: { readonly MessageBody?: string } }) => {
          queuedBody = command.input?.MessageBody;
          throw new Error("queue unavailable");
        },
      } as never,
      "https://sqs.example/send",
      async () => ({
        environmentId: "environment-id",
        inboxId: "inbox-id",
        messageId: "message-id",
        organizationId: "organization-id",
        projectId: "project-id",
        type: "agent-email-send",
      }),
    );
    const result = await dispatcher({
      Records: [
        {
          dynamodb: { SequenceNumber: "123456789" },
          eventID: "event-id",
          eventName: "INSERT",
        },
      ],
    });
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: "123456789" }] });
    expect(JSON.parse(queuedBody ?? "{}")).toEqual({
      environmentId: "environment-id",
      inboxId: "inbox-id",
      messageId: "message-id",
      organizationId: "organization-id",
      projectId: "project-id",
      type: "agent-email-send",
    });
  });
});
