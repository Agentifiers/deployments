import { expect } from "@effect/vitest";
import { SendEmailCommand, type SESv2Client } from "@aws-sdk/client-sesv2";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { eventually } from "../harness/eventually.ts";
import { record, retryUnavailableHttpRequest, stringField } from "../harness/live-agent.ts";
import {
  agentEmailJson as json,
  agentEmailRawMime as rawMime,
  agentEmailRecords as records,
} from "./agent-email-proof-support.ts";
import type { AgentEmailLifecycleClient } from "./agent-email-lifecycle-support.ts";

type JsonRecord = Record<string, unknown>;
type Headers = Readonly<Record<string, string>>;

/** Proof inbound message plus the thread and attachment it landed in. */
interface InboundProof {
  readonly attachment: Buffer;
  readonly emailThreadId: string;
  readonly inboundAttachment: JsonRecord;
  readonly inboundId: string;
}

/** Sends the raw MIME proof through SES and waits for it to land in the target inbox. */
export function sendInboundProof(
  client: AgentEmailLifecycleClient,
  ses: SESv2Client,
  addresses: {
    readonly senderAddress: string;
    readonly targetAddress: string;
    readonly targetInboxId: string;
  },
) {
  const { auth, http, marker } = client;
  const { senderAddress, targetAddress, targetInboxId } = addresses;
  return Effect.gen(function* () {
    const attachment = Buffer.from(`attachment:${marker}`, "utf8");
    const subject = `Agent Email E2E ${marker}`;
    const accepted = yield* Effect.tryPromise({
      try: () =>
        ses.send(
          new SendEmailCommand({
            Content: {
              Raw: {
                Data: rawMime({
                  attachment,
                  from: senderAddress,
                  marker,
                  messageId: randomUUID(),
                  subject,
                  to: targetAddress,
                }),
              },
            },
            Destination: { ToAddresses: [targetAddress] },
            FromEmailAddress: senderAddress,
          }),
        ),
      catch: (cause) => new Error("SES inbound proof send failed.", { cause }),
    });
    const providerMessageId = accepted.MessageId;
    if (!providerMessageId) throw new Error("SES accepted the inbound proof without a message ID.");

    const inboundSummary = yield* eventually(
      {
        label: `inbound Agent Email ${marker} (SES message ${providerMessageId})`,
        timeoutMs: 180_000,
      },
      http
        .request({
          body: { direction: "inbound", limit: 50, query: marker },
          headers: auth,
          method: "POST",
          path: `/v1/agent-email/inboxes/${targetInboxId}/messages/search`,
        })
        .pipe(
          Effect.map((response) => {
            const page = json(response, 200, "inbound message search");
            return records(page.items, "inbound message search.items").find(
              (message) => message.subject === subject,
            );
          }),
        ),
    );
    expect(inboundSummary).not.toHaveProperty("textBody");
    const inboundId = stringField(inboundSummary, "id", "inbound message summary");
    const inbound = json(
      yield* http.request({
        headers: auth,
        method: "GET",
        path: `/v1/agent-email/messages/${inboundId}`,
      }),
      200,
      "inbound message get",
    );
    expect(inbound).toMatchObject({
      direction: "inbound",
      fromAddress: senderAddress,
      status: "received",
      textBody: expect.stringContaining(marker),
      toAddresses: expect.arrayContaining([targetAddress]),
    });
    return {
      attachment,
      emailThreadId: stringField(inbound, "threadId", "inbound message"),
      inboundAttachment: records(inbound.attachments, "inbound attachments")[0]!,
      inboundId,
      subject,
    };
  });
}

function download(url: string, label: string, failure: string) {
  return Effect.tryPromise({
    try: async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${label} returned ${response.status}.`);
      return Buffer.from(await response.arrayBuffer());
    },
    catch: (cause) => new Error(failure, { cause }),
  });
}

/** Proves raw MIME, attachment, and thread reads expose the inbound proof content. */
export function expectInboundContent(
  client: AgentEmailLifecycleClient,
  proof: InboundProof & { readonly subject: string; readonly targetInboxId: string },
) {
  const { auth, http, marker } = client;
  const { attachment, emailThreadId, inboundAttachment, inboundId, subject, targetInboxId } = proof;
  return Effect.gen(function* () {
    const rawAccess = json(
      yield* http.request({
        headers: auth,
        method: "POST",
        path: `/v1/agent-email/messages/${inboundId}/raw/access`,
      }),
      200,
      "raw access",
    );
    const rawBody = yield* download(
      stringField(rawAccess, "url", "raw access"),
      "Raw MIME download",
      "Raw MIME download failed.",
    );
    expect(rawBody.toString("utf8")).toContain(marker);

    const attachmentAccess = json(
      yield* http.request({
        headers: auth,
        method: "POST",
        path: `/v1/agent-email/attachments/${stringField(inboundAttachment, "id", "attachment")}/access-url`,
      }),
      200,
      "attachment access",
    );
    const attachmentBody = yield* download(
      stringField(attachmentAccess, "url", "attachment access"),
      "Attachment download",
      "Agent Email attachment download failed.",
    );
    expect(attachmentBody.equals(attachment)).toBe(true);

    const thread = json(
      yield* http.request({
        headers: auth,
        method: "GET",
        path: `/v1/agent-email/inboxes/${targetInboxId}/threads/${emailThreadId}`,
      }),
      200,
      "email thread get",
    );
    expect(record(thread.thread, "email thread")).toMatchObject({ id: emailThreadId, subject });
    expect(
      records(thread.messages, "email thread.messages").map((message) => message.id),
    ).toContain(inboundId);
  });
}

/** Waits for the email-triggered run to complete and proves its thread holds both turns. */
export function awaitEmailTriggeredRun(
  client: AgentEmailLifecycleClient,
  run: {
    readonly agentDeploymentId: string;
    readonly runtimeAuth: Headers;
    readonly startedAt: string;
  },
) {
  const { http, marker } = client;
  const { agentDeploymentId, runtimeAuth, startedAt } = run;
  return Effect.gen(function* () {
    const completed = yield* eventually(
      { label: `email-triggered agent run ${marker}`, timeoutMs: 240_000 },
      retryUnavailableHttpRequest(
        "email run search",
        http.request({
          body: {
            agentDeploymentId,
            createdAfter: startedAt,
            limit: 20,
          },
          headers: runtimeAuth,
          method: "POST",
          path: "/v1/runs/search",
        }),
      ).pipe(
        Effect.map((response) => {
          const page = json(response, 200, "email run search");
          const candidate = records(page.runs, "email run search.runs").find(
            (value) => value.trigger === "email",
          );
          if (candidate?.status === "failed") {
            throw new Error(`Email-triggered run failed: ${response.body}`);
          }
          return candidate?.status === "completed" ? candidate : undefined;
        }),
      ),
    );
    const runId = stringField(completed, "id", "email run");
    const runThreadId = stringField(completed, "threadId", "email run");
    const runMessages = json(
      yield* http.request({
        headers: runtimeAuth,
        method: "GET",
        path: `/v1/threads/${runThreadId}/messages`,
      }),
      200,
      "email run messages",
    );
    expect(runMessages.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user" }),
        expect.objectContaining({ role: "assistant" }),
      ]),
    );
    return runId;
  });
}

/** Replies through the provider, waits for delivery, and proves the reply reaches the sender. */
export function replyAndAwaitDelivery(
  client: AgentEmailLifecycleClient,
  reply: {
    readonly emailThreadId: string;
    readonly inboundId: string;
    readonly senderInboxId: string;
    readonly targetInboxId: string;
  },
) {
  const { auth, http, marker, runKey } = client;
  const { emailThreadId, inboundId, senderInboxId, targetInboxId } = reply;
  return Effect.gen(function* () {
    const outbound = json(
      yield* retryUnavailableHttpRequest(
        "email reply",
        http.request({
          body: { text: `Provider reply ${marker}` },
          headers: { ...auth, "idempotency-key": `${runKey}:reply` },
          method: "POST",
          path: `/v1/agent-email/messages/${inboundId}/reply`,
        }),
      ),
      202,
      "email reply",
    );
    const outboundId = stringField(outbound, "id", "outbound reply");
    const delivered = yield* eventually(
      { label: `delivered Agent Email reply ${outboundId}`, timeoutMs: 180_000 },
      http
        .request({
          headers: auth,
          method: "GET",
          path: `/v1/agent-email/messages/${outboundId}`,
        })
        .pipe(
          Effect.map((response) => {
            const message = json(response, 200, "outbound reply get");
            if (["bounced", "failed", "complained"].includes(String(message.status))) {
              throw new Error(`Agent Email reply failed: ${response.body}`);
            }
            return message.status === "delivered" ? message : undefined;
          }),
        ),
    );
    expect(delivered).toMatchObject({
      direction: "outbound",
      inboxId: targetInboxId,
      status: "delivered",
      threadId: emailThreadId,
    });

    const replyInboundSummary = yield* eventually(
      { label: `reply ingress into sender inbox ${outboundId}`, timeoutMs: 180_000 },
      http
        .request({
          body: { direction: "inbound", limit: 50, query: marker },
          headers: auth,
          method: "POST",
          path: `/v1/agent-email/inboxes/${senderInboxId}/messages/search`,
        })
        .pipe(
          Effect.map(
            (response) =>
              records(json(response, 200, "reply ingress search").items, "reply ingress.items")[0],
          ),
        ),
    );
    expect(replyInboundSummary).not.toHaveProperty("textBody");
    expect(
      json(
        yield* http.request({
          headers: auth,
          method: "GET",
          path: `/v1/agent-email/messages/${stringField(replyInboundSummary, "id", "reply ingress summary")}`,
        }),
        200,
        "reply ingress get",
      ).textBody,
    ).toContain(marker);
  });
}

/** Proves the draft approval path sends and the rejection path records its reason. */
export function proveDraftApprovalAndRejection(
  client: AgentEmailLifecycleClient,
  drafts: { readonly senderAddress: string; readonly targetInboxId: string },
) {
  const { auth, http, marker, runKey } = client;
  const { senderAddress, targetInboxId } = drafts;
  return Effect.gen(function* () {
    const draft = json(
      yield* http.request({
        body: { subject: `Draft ${marker}`, text: "initial", to: [senderAddress] },
        headers: { ...auth, "idempotency-key": `${runKey}:draft` },
        method: "POST",
        path: `/v1/agent-email/inboxes/${targetInboxId}/drafts`,
      }),
      201,
      "draft create",
    );
    const draftId = stringField(draft, "id", "draft");
    const updatedDraftSummary = json(
      yield* http.request({
        body: { text: `Approved draft ${marker}` },
        headers: { ...auth, "idempotency-key": `${runKey}:draft:update` },
        method: "PATCH",
        path: `/v1/agent-email/drafts/${draftId}`,
      }),
      200,
      "draft update",
    );
    expect(updatedDraftSummary).not.toHaveProperty("textBody");
    expect(
      json(
        yield* http.request({
          headers: auth,
          method: "GET",
          path: `/v1/agent-email/drafts/${draftId}`,
        }),
        200,
        "updated draft get",
      ).textBody,
    ).toContain(marker);
    for (const action of ["submit", "approve"] as const) {
      const transitioned = json(
        yield* http.request({
          headers: { ...auth, "idempotency-key": `${runKey}:draft:${action}` },
          method: "POST",
          path: `/v1/agent-email/drafts/${draftId}/${action}`,
        }),
        200,
        `draft ${action}`,
      );
      expect(transitioned.status).toBe(action === "submit" ? "pending_approval" : "approved");
    }
    const draftMessage = json(
      yield* http.request({
        headers: { ...auth, "idempotency-key": `${runKey}:draft:send` },
        method: "POST",
        path: `/v1/agent-email/drafts/${draftId}/send`,
      }),
      202,
      "draft send",
    );
    expect(draftMessage).toMatchObject({ direction: "outbound", draftId });

    const rejectedDraft = json(
      yield* http.request({
        body: { subject: `Reject ${marker}`, text: marker, to: [senderAddress] },
        headers: { ...auth, "idempotency-key": `${runKey}:draft:reject:create` },
        method: "POST",
        path: `/v1/agent-email/inboxes/${targetInboxId}/drafts`,
      }),
      201,
      "rejected draft create",
    );
    const rejectedDraftId = stringField(rejectedDraft, "id", "rejected draft");
    json(
      yield* http.request({
        headers: { ...auth, "idempotency-key": `${runKey}:draft:reject:submit` },
        method: "POST",
        path: `/v1/agent-email/drafts/${rejectedDraftId}/submit`,
      }),
      200,
      "rejected draft submit",
    );
    expect(
      json(
        yield* http.request({
          body: { reason: `E2E rejection ${marker}` },
          headers: { ...auth, "idempotency-key": `${runKey}:draft:reject` },
          method: "POST",
          path: `/v1/agent-email/drafts/${rejectedDraftId}/reject`,
        }),
        200,
        "draft reject",
      ),
    ).toMatchObject({ failureReason: expect.stringContaining(marker), status: "rejected" });
  });
}

/** Requests raw reprocessing of the inbound proof and waits for its reprocess count. */
export function reprocessInbound(client: AgentEmailLifecycleClient, inboundId: string) {
  const { auth, http, runKey } = client;
  return Effect.gen(function* () {
    json(
      yield* http.request({
        headers: { ...auth, "idempotency-key": `${runKey}:reprocess` },
        method: "POST",
        path: `/v1/agent-email/messages/${inboundId}/raw/reprocess`,
      }),
      202,
      "inbound reprocess",
    );
    yield* eventually(
      { label: `raw reprocess ${inboundId}`, timeoutMs: 120_000 },
      http
        .request({
          headers: auth,
          method: "GET",
          path: `/v1/agent-email/messages/${inboundId}`,
        })
        .pipe(
          Effect.map((response) => {
            const message = json(response, 200, "reprocessed message");
            return Number(message.reprocessCount) >= 1 ? message : undefined;
          }),
        ),
    );
  });
}

/** Waits for inbound and outbound usage to be metered, then proves the usage export. */
export function expectMeteredUsage(
  client: AgentEmailLifecycleClient,
  usage: {
    readonly organizationId: string;
    readonly startedAt: string;
    readonly targetInboxId: string;
  },
) {
  const { auth, http, marker } = client;
  const { organizationId, startedAt, targetInboxId } = usage;
  return Effect.gen(function* () {
    const summary = yield* eventually(
      { label: `Agent Email usage ${marker}`, timeoutMs: 120_000 },
      http
        .request({
          headers: auth,
          method: "GET",
          path: `/v1/agent-email/usage?from=${encodeURIComponent(startedAt)}&inboxId=${targetInboxId}`,
        })
        .pipe(
          Effect.map((response) => {
            const value = json(response, 200, "email usage");
            return Number(value.inboundMessages) >= 1 && Number(value.outboundMessages) >= 1
              ? value
              : undefined;
          }),
        ),
    );
    expect(summary).toMatchObject({ organizationId });
    const exportedUsage = json(
      yield* http.request({
        body: { format: "json", from: startedAt, inboxId: targetInboxId },
        headers: auth,
        method: "POST",
        path: "/v1/agent-email/usage/export",
      }),
      200,
      "email usage export",
    );
    expect(records(exportedUsage.rows, "email usage export.rows").length).toBeGreaterThan(0);
  });
}
