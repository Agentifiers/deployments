import { describe, expect, test } from "bun:test";
import { type DynamoDatabaseService } from "@deployments-ai/db";
import { TelegramApiError } from "@deployments-ai/channel-adapters/telegram";
import { handleChannelDelivery, type ChannelDeliveryDependencies } from "./delivery.ts";
import { RetryableAwsRcsPreSendError } from "./aws-rcs-delivery.ts";
import { fixture, persistedDelivery, timestamp } from "./delivery-test-support.ts";

describe("channel delivery worker", () => {
  test("moves queued deliveries through sending to sent with provider correlation", async () => {
    const { dependencies, event, memory } = fixture("queued", [
      { chat_id: "123", text: "Part one" },
      { chat_id: "123", text: "Part two" },
    ]);
    const sends: unknown[] = [];
    const response = await handleChannelDelivery(event, {
      ...dependencies,
      sendTelegram: async (token, payload) => {
        sends.push({ payload, token });
        return { providerMessageId: `telegram-message-${sends.length}` };
      },
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(sends).toHaveLength(2);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 1,
      providerMessageId: "telegram-message-2",
      status: "sent",
      version: 2,
    });
    expect(
      [...memory.records.values()]
        .filter((record) => record.itemType === "semantic-event")
        .map((record) => record.data.eventType),
    ).toEqual(["channel.delivery.sending", "channel.delivery.sent"]);
  });

  test("sends AWS RCS through the binding-owned cross-account identity", async () => {
    const payload = {
      DestinationPhoneNumber: "+16025550123",
      OriginationIdentity: "arn:aws:sms-voice:us-east-2:123456789012:rcs-agent/rcs-123",
      RcsMessageContent: { Content: { TextMessage: { Body: "Deployment complete." } } },
    };
    const { dependencies, event, memory } = fixture(
      "queued",
      payload,
      "aws_end_user_messaging_rcs",
    );
    const preparations: unknown[] = [];
    const sends: unknown[] = [];
    const response = await handleChannelDelivery(event, {
      ...dependencies,
      readCredential: async () => ({
        externalId: "external-id",
        region: "us-east-2",
        roleArn: "arn:aws:iam::123456789012:role/vertical-rcs-delivery",
      }),
      prepareAwsRcs: async (credential) => {
        preparations.push(credential);
        return async (receivedPayload) => {
          sends.push(receivedPayload);
          return { providerMessageId: "aws-rcs-message-1" };
        };
      },
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(preparations).toEqual([
      {
        externalId: "external-id",
        region: "us-east-2",
        roleArn: "arn:aws:iam::123456789012:role/vertical-rcs-delivery",
      },
    ]);
    expect(sends).toEqual([payload]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      providerMessageId: "aws-rcs-message-1",
      status: "sent",
    });
  });

  test("retries transient AWS role assumption failures before provider dispatch", async () => {
    const { dependencies, event, memory } = fixture(
      "queued",
      {
        DestinationPhoneNumber: "+16025550123",
        OriginationIdentity: "rcs-agent-1",
        RcsMessageContent: { Content: { TextMessage: { Body: "Hello" } } },
      },
      "aws_end_user_messaging_rcs",
    );
    const response = await handleChannelDelivery(event, {
      ...dependencies,
      readCredential: async () => ({
        externalId: "external-id",
        region: "us-east-2",
        roleArn: "arn:aws:iam::123456789012:role/vertical-rcs-delivery",
      }),
      prepareAwsRcs: async () => {
        throw new RetryableAwsRcsPreSendError({ name: "ThrottlingException" });
      },
    });

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "queue-message-1" }]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 0,
      status: "queued",
      version: 0,
    });
  });

  test("retries definite AWS RCS throttling rejections", async () => {
    const { dependencies, event, memory } = fixture(
      "queued",
      {
        DestinationPhoneNumber: "+16025550123",
        OriginationIdentity: "rcs-agent-1",
        RcsMessageContent: { Content: { TextMessage: { Body: "Hello" } } },
      },
      "aws_end_user_messaging_rcs",
    );
    const response = await handleChannelDelivery(event, {
      ...dependencies,
      readCredential: async () => ({
        externalId: "external-id",
        region: "us-east-2",
        roleArn: "arn:aws:iam::123456789012:role/vertical-rcs-delivery",
      }),
      prepareAwsRcs: async () => async () => {
        throw { $retryable: { throttling: true }, name: "ThrottlingException" };
      },
    });

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "queue-message-1" }]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 1,
      status: "queued",
      version: 2,
    });
  });

  test("continues after an ambiguous queued-to-sending transaction commit", async () => {
    const { dependencies, event, memory } = fixture();
    const transactWrite = dependencies.database.transactWrite;
    let obscureSendingCommit = true;
    let sends = 0;
    const obscureSendingTransaction: DynamoDatabaseService["transactWrite"] = (
      operations,
      clientRequestToken,
      signal,
    ) => {
      const transaction = transactWrite(operations, clientRequestToken, signal);
      if (
        obscureSendingCommit &&
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "semantic-event" &&
            operation.record.data.eventType === "channel.delivery.sending",
        )
      ) {
        obscureSendingCommit = false;
        return transaction.then(() => {
          throw new Error("ambiguous transaction response");
        });
      }
      return transaction;
    };
    const response = await handleChannelDelivery(event, {
      ...dependencies,
      database: {
        ...dependencies.database,
        transactWrite: obscureSendingTransaction,
      },
      sendTelegram: async () => {
        sends += 1;
        return { providerMessageId: "telegram-message-1" };
      },
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(sends).toBe(1);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      providerMessageId: "telegram-message-1",
      status: "sent",
      version: 2,
    });
  });

  test("persists provider failures as terminal delivery state", async () => {
    const { dependencies, event, memory } = fixture();
    const response = await handleChannelDelivery(event, {
      ...dependencies,
      sendTelegram: async () => {
        throw new Error("telegram unavailable");
      },
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 1,
      lastError: "telegram unavailable",
      status: "failed",
      version: 2,
    });
  });

  test("does not replay ambiguous Telegram service failures", async () => {
    const { dependencies, event, memory } = fixture();
    const response = await handleChannelDelivery(event, {
      ...dependencies,
      sendTelegram: async () => {
        throw new TelegramApiError(503, { description: "service unavailable" });
      },
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 1,
      lastError: "Telegram API request failed with status 503.",
      status: "failed",
      version: 2,
    });
  });

  test("leaves credential resolution failures queued for retry", async () => {
    const { dependencies, event, memory } = fixture();
    const response = await handleChannelDelivery(event, {
      ...dependencies,
      readCredential: async () => {
        throw new Error("credential vault unavailable");
      },
    });

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "queue-message-1" }]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 0,
      status: "queued",
      version: 0,
    });
  });

  test("finalizes credential resolution failures on the last queue receive", async () => {
    const { dependencies, event, memory } = fixture();
    const response = await handleChannelDelivery(
      {
        Records: event.Records.map((record) => ({
          ...record,
          attributes: { ApproximateReceiveCount: "5" },
        })),
      },
      {
        ...dependencies,
        readCredential: async () => {
          throw new Error("pinned credential generation is unavailable");
        },
      },
    );

    expect(response.batchItemFailures).toEqual([]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 0,
      lastError: "pinned credential generation is unavailable",
      status: "failed",
      version: 1,
    });
  });

  test("finalizes missing provider credential fields on the last queue receive", async () => {
    const { dependencies, event, memory } = fixture();
    const response = await handleChannelDelivery(
      {
        Records: event.Records.map((record) => ({
          ...record,
          attributes: { ApproximateReceiveCount: "5" },
        })),
      },
      {
        ...dependencies,
        readCredential: async () => ({ unrelated: "value" }),
      },
    );

    expect(response.batchItemFailures).toEqual([]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 0,
      lastError: "Credential is missing botToken.",
      status: "failed",
      version: 1,
    });
  });

  test("reserves the last queue receive for terminal-state persistence recovery", async () => {
    const { dependencies, event, memory } = fixture();
    const transactWrite = dependencies.database.transactWrite;
    // transition() retries the transaction once in-process, so both attempts of the first
    // terminal write must fail for the failure to surface on this receive.
    let terminalFailuresRemaining = 2;
    const failTerminalTransaction: DynamoDatabaseService["transactWrite"] = (
      operations,
      clientRequestToken,
      signal,
    ) => {
      if (
        terminalFailuresRemaining > 0 &&
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "semantic-event" &&
            operation.record.data.eventType === "channel.delivery.failed",
        )
      ) {
        terminalFailuresRemaining -= 1;
        return Promise.reject(new Error("transient terminal persistence failure"));
      }
      return transactWrite(operations, clientRequestToken, signal);
    };
    const recoveringDependencies: ChannelDeliveryDependencies = {
      ...dependencies,
      database: {
        ...dependencies.database,
        transactWrite: failTerminalTransaction,
      },
      readCredential: async () => {
        throw new Error("pinned credential generation is unavailable");
      },
    };
    const receive = (count: string) => ({
      Records: event.Records.map((record) => ({
        ...record,
        attributes: { ApproximateReceiveCount: count },
      })),
    });

    expect(await handleChannelDelivery(receive("4"), recoveringDependencies)).toEqual({
      batchItemFailures: [{ itemIdentifier: "queue-message-1" }],
    });
    expect(persistedDelivery(memory)?.data.status).toBe("queued");
    expect(await handleChannelDelivery(receive("5"), recoveringDependencies)).toEqual({
      batchItemFailures: [],
    });
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 0,
      lastError: "pinned credential generation is unavailable",
      status: "failed",
      version: 1,
    });
  });

  test("requeues provider-declared transient failures before the last receive", async () => {
    const { dependencies, event, memory } = fixture();
    const response = await handleChannelDelivery(event, {
      ...dependencies,
      sendTelegram: async () => {
        throw new TelegramApiError(429, { description: "retry later" });
      },
    });

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "queue-message-1" }]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 1,
      lastError: "Telegram API request failed with status 429.",
      status: "queued",
      version: 2,
    });
    expect(
      [...memory.records.values()]
        .filter((record) => record.itemType === "semantic-event")
        .map((record) => record.data.eventType),
    ).toEqual(["channel.delivery.sending", "channel.delivery.retrying"]);
  });

  test("reconciles retry-state persistence without another provider call", async () => {
    const { dependencies, event, memory } = fixture();
    const transactWrite = dependencies.database.transactWrite;
    // transition() retries the transaction once in-process, so both attempts of the first
    // retry-state write must fail to reach the persisted-state reconciliation.
    let retryFailuresRemaining = 2;
    let sends = 0;
    const response = await handleChannelDelivery(event, {
      ...dependencies,
      database: {
        ...dependencies.database,
        transactWrite: (operations, clientRequestToken, signal) => {
          if (
            retryFailuresRemaining > 0 &&
            operations.some(
              (operation) =>
                operation.kind === "put" &&
                operation.record.itemType === "semantic-event" &&
                operation.record.data.eventType === "channel.delivery.retrying",
            )
          ) {
            retryFailuresRemaining -= 1;
            return Promise.reject(new Error("transient retry persistence failure"));
          }
          return transactWrite(operations, clientRequestToken, signal);
        },
      },
      sendTelegram: async () => {
        sends += 1;
        throw new TelegramApiError(429, { description: "retry later" });
      },
    });

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "queue-message-1" }]);
    expect(sends).toBe(1);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 1,
      status: "queued",
      version: 2,
    });
  });

  test("does not replay Telegram parts after a later part fails", async () => {
    const { dependencies, event, memory } = fixture("queued", [
      { chat_id: "123", text: "Part one" },
      { chat_id: "123", text: "Part two" },
    ]);
    let sends = 0;
    const response = await handleChannelDelivery(event, {
      ...dependencies,
      sendTelegram: async () => {
        sends += 1;
        if (sends === 2) throw new TelegramApiError(429, { description: "retry later" });
        return { providerMessageId: "telegram-message-1" };
      },
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(sends).toBe(2);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 1,
      lastError:
        "Telegram delivery outcome is partial after 1 sent part; automatic replay was suppressed.",
      status: "failed",
      version: 2,
    });
  });

  test("retries sent-state persistence without calling the provider twice", async () => {
    const { dependencies, event, memory } = fixture();
    const transactWrite = dependencies.database.transactWrite;
    // transition() retries the transaction once in-process, so both attempts of the first
    // sent-state write must fail to reach the persisted-state recovery loop.
    let sentFailuresRemaining = 2;
    let sends = 0;
    const response = await handleChannelDelivery(event, {
      ...dependencies,
      database: {
        ...dependencies.database,
        transactWrite: (operations, clientRequestToken, signal) => {
          if (
            sentFailuresRemaining > 0 &&
            operations.some(
              (operation) =>
                operation.kind === "put" &&
                operation.record.itemType === "semantic-event" &&
                operation.record.data.eventType === "channel.delivery.sent",
            )
          ) {
            sentFailuresRemaining -= 1;
            return Promise.reject(new Error("transient sent persistence failure"));
          }
          return transactWrite(operations, clientRequestToken, signal);
        },
      },
      sendTelegram: async () => {
        sends += 1;
        return { providerMessageId: "telegram-message-1" };
      },
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(sends).toBe(1);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      providerMessageId: "telegram-message-1",
      status: "sent",
      version: 2,
    });
  });

  test("does not resend terminal sent deliveries", async () => {
    const { dependencies, event, memory } = fixture("sent");
    let reads = 0;
    let sends = 0;
    const response = await handleChannelDelivery(event, {
      ...dependencies,
      readCredential: async () => {
        reads += 1;
        return { botToken: "telegram-token" };
      },
      sendTelegram: async () => {
        sends += 1;
        return {};
      },
    });

    expect(response.batchItemFailures).toEqual([]);
    expect({ reads, sends }).toEqual({ reads: 0, sends: 0 });
    expect(persistedDelivery(memory)?.data.status).toBe("sent");
  });

  test("retries a fresh concurrent sending state without changing it", async () => {
    const { dependencies, event, memory } = fixture("sending");
    let sends = 0;
    const response = await handleChannelDelivery(event, {
      ...dependencies,
      sendTelegram: async () => {
        sends += 1;
        return {};
      },
    });

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "queue-message-1" }]);
    expect(sends).toBe(0);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 1,
      status: "sending",
      version: 1,
    });
  });

  test("terminalizes a fresh ambiguous sending state on the final receive", async () => {
    const { dependencies, event, memory } = fixture("sending");
    const response = await handleChannelDelivery(
      {
        Records: event.Records.map((record) => ({
          ...record,
          attributes: { ApproximateReceiveCount: "5" },
        })),
      },
      dependencies,
    );

    expect(response.batchItemFailures).toEqual([]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 1,
      lastError: "Provider delivery outcome is unknown; automatic resend was suppressed.",
      status: "failed",
      version: 2,
    });
  });

  test("suppresses resend after a stale ambiguous sending state", async () => {
    const { dependencies, event, memory } = fixture("sending");
    let sends = 0;
    const response = await handleChannelDelivery(event, {
      ...dependencies,
      now: () => new Date(Date.parse(timestamp) + 5 * 60_000),
      sendTelegram: async () => {
        sends += 1;
        return {};
      },
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(sends).toBe(0);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      attempts: 1,
      lastError: "Provider delivery outcome is unknown; automatic resend was suppressed.",
      status: "failed",
      version: 2,
    });
  });
});
