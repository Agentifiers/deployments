import { describe, expect, test } from "bun:test";
import { ChannelDeliveryRecord, withCanonicalRecordKeys } from "@deployments-ai/db";
import { Schema } from "effect";
import { handleChannelDelivery } from "./delivery.ts";
import { fixture, persistedDelivery } from "./delivery-test-support.ts";

describe("channel delivery worker", () => {
  function externalFixture(status: "failed" | "queued" | "sent" = "queued") {
    const test = fixture(status);
    const delivery = Schema.decodeUnknownSync(ChannelDeliveryRecord)(
      withCanonicalRecordKeys({
        ...test.delivery,
        data: {
          ...test.delivery.data,
          bindingId: test.delivery.data.bindingId!,
          publicationContent: "A concise current reply.",
          responsePublication: "external",
          routeId: "a".repeat(64),
          sourceMessageId: test.delivery.data.runId,
          sourceMessageSequence: 4,
          throughSequence: 2,
        },
      }),
    );
    test.memory.records.set(`execution\0${delivery.pk}\0${delivery.sk}`, delivery);
    return { ...test, delivery };
  }

  test("suppresses a provisional response when newer channel input already exists", async () => {
    const { dependencies, event, memory } = externalFixture();
    const calls: string[] = [];

    const response = await handleChannelDelivery(event, {
      ...dependencies,
      externalPublication: {
        publish: async () => void calls.push("publish"),
        release: async () => void calls.push("release"),
        reserve: async () => {
          calls.push("reserve");
          return "superseded";
        },
      },
      ingressDispatch: {
        assess: async () => {
          calls.push("fence");
          return { kind: "superseded" };
        },
      },
      sendTelegram: async () => {
        calls.push("send");
        return {};
      },
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(calls).toEqual(["reserve"]);
    expect(persistedDelivery(memory)?.data).toMatchObject({
      lastError: expect.stringContaining("superseded"),
      status: "failed",
    });
  });

  test("releases a reservation when the ingress fence detects a later bubble", async () => {
    const { dependencies, event, memory } = externalFixture();
    const calls: string[] = [];

    const response = await handleChannelDelivery(event, {
      ...dependencies,
      externalPublication: {
        publish: async () => void calls.push("publish"),
        release: async () => void calls.push("release"),
        reserve: async () => {
          calls.push("reserve");
          return "reserved";
        },
      },
      ingressDispatch: {
        assess: async () => {
          calls.push("fence");
          return { kind: "superseded" };
        },
      },
      sendTelegram: async () => {
        calls.push("send");
        return {};
      },
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(calls).toEqual(["reserve", "fence", "release"]);
    expect(persistedDelivery(memory)?.data.status).toBe("failed");
  });

  test("publishes only after a fenced provider send is durably recorded", async () => {
    const { dependencies, delivery, event, memory } = externalFixture();
    const calls: string[] = [];

    const response = await handleChannelDelivery(event, {
      ...dependencies,
      externalPublication: {
        publish: async () => void calls.push(`publish:${persistedDelivery(memory)?.data.status}`),
        release: async () => void calls.push("release"),
        reserve: async () => {
          calls.push("reserve");
          return "reserved";
        },
      },
      ingressDispatch: {
        assess: async () => {
          calls.push("fence");
          return {
            condition: {
              conditionExpression: "attribute_exists(pk)",
              key: { pk: delivery.pk, sk: delivery.sk },
              kind: "condition-check",
              table: "execution",
            },
            kind: "current",
          };
        },
      },
      sendTelegram: async () => {
        calls.push("send");
        return { providerMessageId: "telegram-message-1" };
      },
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(calls).toEqual(["reserve", "fence", "send", "publish:sent"]);
    expect(persistedDelivery(memory)?.data.status).toBe("sent");
  });

  test("finishes publication for an already-sent delivery without resending", async () => {
    const { dependencies, event } = externalFixture("sent");
    const calls: string[] = [];

    const response = await handleChannelDelivery(event, {
      ...dependencies,
      externalPublication: {
        publish: async () => void calls.push("publish"),
        release: async () => void calls.push("release"),
        reserve: async () => {
          calls.push("reserve");
          return "reserved";
        },
      },
      ingressDispatch: { assess: async () => ({ kind: "superseded" }) },
      sendTelegram: async () => {
        calls.push("send");
        return {};
      },
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(calls).toEqual(["publish"]);
  });

  test("reconciles a failed external delivery even when no reservation was created", async () => {
    const { dependencies, event } = externalFixture("failed");
    const calls: string[] = [];

    const response = await handleChannelDelivery(event, {
      ...dependencies,
      externalPublication: {
        publish: async () => void calls.push("publish"),
        release: async () => void calls.push("release:no-reservation"),
        reserve: async () => {
          calls.push("reserve");
          return "reserved";
        },
      },
      sendTelegram: async () => {
        calls.push("send");
        return {};
      },
    });

    expect(response.batchItemFailures).toEqual([]);
    expect(calls).toEqual(["release:no-reservation"]);
  });

  test("retries publication release without retrying terminal provider delivery", async () => {
    const { dependencies, event, memory } = externalFixture("failed");
    let releaseAttempts = 0;
    let sends = 0;
    const externalPublication = {
      publish: async () => {},
      release: async () => {
        releaseAttempts += 1;
        if (releaseAttempts === 1) throw new Error("publication persistence unavailable");
      },
      reserve: async () => "reserved" as const,
    };

    expect(
      await handleChannelDelivery(event, {
        ...dependencies,
        externalPublication,
        sendTelegram: async () => {
          sends += 1;
          return {};
        },
      }),
    ).toEqual({ batchItemFailures: [{ itemIdentifier: "queue-message-1" }] });
    expect(persistedDelivery(memory)?.data.status).toBe("failed");

    expect(
      await handleChannelDelivery(event, {
        ...dependencies,
        externalPublication,
        sendTelegram: async () => {
          sends += 1;
          return {};
        },
      }),
    ).toEqual({ batchItemFailures: [] });
    expect({ releaseAttempts, sends }).toEqual({ releaseAttempts: 2, sends: 0 });
  });
});
