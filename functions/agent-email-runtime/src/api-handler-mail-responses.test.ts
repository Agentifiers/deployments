import { inboxDomainRecord, inboxPolicyRecord, inboxRecord } from "@deployments-ai/db";
import { testEndUserKeys } from "@deployments-ai/db/erasure-testing";
import { describe, expect, test } from "bun:test";
import { createAgentEmailApiHandler, type AgentEmailHttpEvent } from "./api-handler.ts";
import { createDynamoAgentEmailApplicationService } from "./application-service.ts";
import {
  INBOX_ID,
  NOW,
  database,
  domain,
  inbox,
  invocation,
  policy,
  scope,
} from "./application-service-test-support.ts";

function request(
  method: string,
  rawPath: string,
  body?: Readonly<Record<string, unknown>>,
): AgentEmailHttpEvent {
  return {
    ...(body ? { body: JSON.stringify(body) } : {}),
    headers: {
      authorization: "Bearer credential",
      "x-deployments-environment": scope.environmentId,
      ...(method === "GET" ? {} : { "idempotency-key": `${method} ${rawPath}` }),
    },
    rawPath,
    requestContext: { http: { method }, requestId: "request_1" },
  };
}

describe("agent email API mail responses", () => {
  test("message and draft responses carry no correspondent subject keys", async () => {
    let nextId = 0;
    const handler = createAgentEmailApiHandler({
      authenticate: async () => invocation(undefined).identity,
      idempotency: { execute: async (input) => input.operation() },
      service: createDynamoAgentEmailApplicationService({
        createId: () => `01ARZ3NDEKTSV4RRFFQ69G6${String((nextId += 1)).padStart(3, "0")}`,
        database: database([
          inboxDomainRecord(scope, domain()),
          inboxRecord(scope, inbox()),
          inboxPolicyRecord(scope, policy({ allowlist: ["customer@example.com"] })),
        ]).service,
        endUserKeys: testEndUserKeys,
        now: () => new Date(NOW),
      }),
    });
    const call = async (event: AgentEmailHttpEvent) =>
      JSON.parse((await handler(event)).body) as Readonly<Record<string, unknown>>;

    const sent = await call(
      request("POST", `/v1/agent-email/inboxes/${INBOX_ID}/messages`, {
        subject: "Your order",
        text: "It shipped.",
        to: ["customer@example.com"],
      }),
    );
    const draft = await call(
      request("POST", `/v1/agent-email/inboxes/${INBOX_ID}/drafts`, {
        subject: "Following up",
        text: "Any questions?",
        to: ["customer@example.com"],
      }),
    );
    const responses = {
      draft,
      draftList: await call(request("GET", `/v1/agent-email/inboxes/${INBOX_ID}/drafts`)),
      draftRead: await call(request("GET", `/v1/agent-email/drafts/${String(draft.id)}`)),
      message: await call(request("GET", `/v1/agent-email/messages/${String(sent.id)}`)),
      messageList: await call(request("GET", `/v1/agent-email/inboxes/${INBOX_ID}/messages`)),
      sent,
    };

    expect({
      draft: responses.draft.toAddresses,
      draftList: (responses.draftList.items as { toAddresses: unknown }[]).map(
        (item) => item.toAddresses,
      ),
      draftRead: responses.draftRead.toAddresses,
      message: responses.message.toAddresses,
      messageList: (responses.messageList.items as { toAddresses: unknown }[]).map(
        (item) => item.toAddresses,
      ),
      sent: responses.sent.toAddresses,
    }).toEqual({
      draft: ["customer@example.com"],
      draftList: [["customer@example.com"]],
      draftRead: ["customer@example.com"],
      message: ["customer@example.com"],
      messageList: [["customer@example.com"]],
      sent: ["customer@example.com"],
    });
    expect(JSON.stringify(responses)).not.toContain("participantKeys");
  });
});
