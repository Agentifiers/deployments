import { describe, expect, test } from "bun:test";
import type { Ulid } from "@deployments-ai/db";

import type { ChannelDeliveryDependencies, Delivery } from "./delivery-contract.ts";
import { handleChannelDelivery } from "./delivery.ts";
import {
  addTeamsStream,
  finalReceive,
  persistedTeamsStream,
  teamsDeliveryFixture,
  teamsPayload,
} from "./delivery-teams-test-support.ts";
import { persistedDelivery, timestamp, type MemoryDatabase } from "./delivery-test-support.ts";

const STREAM_FALLBACK = {
  deliveryMode: "teams-stream-fallback" as const,
  teamsStreamRunClaimedAt: timestamp,
};

function externalPublicationDependencies(
  test: {
    readonly delivery: Delivery;
    readonly dependencies: ChannelDeliveryDependencies;
    readonly memory: MemoryDatabase;
  },
  dispatch: "current" | "superseded" = "current",
) {
  const calls: string[] = [];
  return {
    calls,
    dependencies: {
      ...test.dependencies,
      externalPublication: {
        publish: async () =>
          void calls.push(`publish:${persistedDelivery(test.memory)?.data.status}`),
        release: async () => void calls.push("release"),
        reserve: async () => {
          calls.push("reserve");
          return "reserved" as const;
        },
      },
      ingressDispatch: {
        assess: async () => {
          calls.push("fence");
          return dispatch === "superseded"
            ? { kind: "superseded" as const }
            : {
                condition: {
                  conditionExpression: "attribute_exists(pk)",
                  key: { pk: test.delivery.pk, sk: test.delivery.sk },
                  kind: "condition-check" as const,
                  table: "execution" as const,
                },
                kind: "current" as const,
              };
        },
      },
    },
  };
}

const externalDelivery = {
  ...STREAM_FALLBACK,
  publicationContent: "A concise current reply.",
  responsePublication: "external" as const,
  routeId: "a".repeat(64),
  sourceMessageSequence: 4,
  throughSequence: 2,
};

describe("Teams stream fallback deliveries", () => {
  test("records a stopped stream as sent with its stream id without posting again", async () => {
    const fixture = teamsDeliveryFixture(STREAM_FALLBACK);
    addTeamsStream(fixture.memory, fixture.delivery);

    const response = await handleChannelDelivery(fixture.event, fixture.dependencies);

    expect(response.batchItemFailures).toEqual([]);
    expect(fixture.connector.requests).toEqual([]);
    expect(persistedDelivery(fixture.memory)?.data).toMatchObject({
      attempts: 1,
      providerMessageId: "stream-1",
      status: "sent",
    });
  });

  test("does not credit a newer stopped stream for an obsolete fallback", async () => {
    const fixture = teamsDeliveryFixture({
      ...STREAM_FALLBACK,
      teamsStreamRunClaimedAt: "2026-07-25T11:00:00.000Z",
    });
    addTeamsStream(fixture.memory, fixture.delivery);

    const response = await handleChannelDelivery(fixture.event, fixture.dependencies);

    expect(response.batchItemFailures).toEqual([]);
    expect(fixture.connector.requests).toEqual([]);
    expect(persistedDelivery(fixture.memory)?.data).toMatchObject({
      lastError: "Teams fallback delivery belongs to an obsolete stream generation.",
      status: "failed",
    });
  });

  test("posts one fallback for a safely failed stream, fenced by a stream reservation", async () => {
    const fixture = teamsDeliveryFixture(STREAM_FALLBACK);
    const stream = addTeamsStream(fixture.memory, fixture.delivery, {
      fallbackAllowed: true,
      status: "failed",
    });

    expect(await handleChannelDelivery(fixture.event, fixture.dependencies)).toEqual({
      batchItemFailures: [],
    });
    expect(await handleChannelDelivery(fixture.event, fixture.dependencies)).toEqual({
      batchItemFailures: [],
    });

    expect(fixture.connector.activityRequests()).toHaveLength(1);
    expect(JSON.parse(fixture.connector.activityRequests()[0]?.body ?? "")).toMatchObject({
      text: teamsPayload.text,
    });
    expect(
      fixture.memory.transactionInputs.some((operations) =>
        operations.some(
          (operation) =>
            operation.kind === "put" &&
            operation.record.itemType === "teams-agent-stream" &&
            operation.record.data.fallbackDeliveryId === fixture.delivery.data.id &&
            operation.previousRecord?.itemType === "teams-agent-stream" &&
            operation.previousRecord.data.version === stream.data.version,
        ),
      ),
    ).toBe(true);
    expect(persistedTeamsStream(fixture.memory)?.data).not.toHaveProperty("fallbackDeliveryId");
    expect(persistedDelivery(fixture.memory)?.data).toMatchObject({
      providerMessageId: "activity-1",
      status: "sent",
    });
  });

  test("waits while another delivery holds the stream's fallback reservation", async () => {
    const fixture = teamsDeliveryFixture(STREAM_FALLBACK);
    addTeamsStream(fixture.memory, fixture.delivery, {
      fallbackAllowed: true,
      fallbackDeliveryId: "01ARZ3NDEKTSV4RRFFQ69G0099" as Ulid,
      status: "failed",
    });

    const response = await handleChannelDelivery(fixture.event, fixture.dependencies);

    expect(response.batchItemFailures).toEqual([{ itemIdentifier: "queue-message-1" }]);
    expect(fixture.connector.requests).toEqual([]);
    expect(persistedDelivery(fixture.memory)?.data.status).toBe("queued");
  });

  test("fails an obsolete failed-stream fallback on the final receive", async () => {
    const fixture = teamsDeliveryFixture({
      ...STREAM_FALLBACK,
      teamsStreamRunClaimedAt: "2026-07-25T11:00:00.000Z",
    });
    addTeamsStream(fixture.memory, fixture.delivery, { fallbackAllowed: true, status: "failed" });

    expect(await handleChannelDelivery(fixture.event, fixture.dependencies)).toEqual({
      batchItemFailures: [{ itemIdentifier: "queue-message-1" }],
    });
    expect(await handleChannelDelivery(finalReceive(fixture.event), fixture.dependencies)).toEqual({
      batchItemFailures: [],
    });

    expect(fixture.connector.requests).toEqual([]);
    expect(persistedDelivery(fixture.memory)?.data).toMatchObject({
      lastError: "Teams fallback delivery belongs to an obsolete failed generation.",
      status: "failed",
    });
  });

  test("suppresses fallback for an unresolved stream until the final receive", async () => {
    const fixture = teamsDeliveryFixture(STREAM_FALLBACK);
    const stream = addTeamsStream(fixture.memory, fixture.delivery, {
      fallbackAllowed: false,
      status: "failed",
    });

    expect(await handleChannelDelivery(fixture.event, fixture.dependencies)).toEqual({
      batchItemFailures: [{ itemIdentifier: "queue-message-1" }],
    });
    expect(persistedDelivery(fixture.memory)?.data.status).toBe("queued");

    expect(await handleChannelDelivery(finalReceive(fixture.event), fixture.dependencies)).toEqual({
      batchItemFailures: [],
    });

    expect(fixture.connector.requests).toEqual([]);
    expect(persistedDelivery(fixture.memory)?.data).toMatchObject({
      lastError: "Teams agent stream outcome is unknown; fallback delivery was suppressed.",
      status: "failed",
    });
    expect(
      fixture.memory.transactionInputs.some((operations) =>
        operations.some(
          (operation) =>
            operation.kind === "condition-check" &&
            operation.key.sk === stream.sk &&
            operation.expressionAttributeValues?.[":version"] === stream.data.version,
        ),
      ),
    ).toBe(true);
  });

  test("fails closed when Teams stream evidence is missing", async () => {
    const fixture = teamsDeliveryFixture(STREAM_FALLBACK);

    const response = await handleChannelDelivery(finalReceive(fixture.event), fixture.dependencies);

    expect(response.batchItemFailures).toEqual([]);
    expect(fixture.connector.requests).toEqual([]);
    expect(persistedDelivery(fixture.memory)?.data).toMatchObject({
      lastError: "Teams agent stream evidence is unavailable; fallback was suppressed.",
      status: "failed",
    });
  });

  test("publishes a stopped stream's external response as confirmed without posting", async () => {
    const fixture = teamsDeliveryFixture(externalDelivery);
    addTeamsStream(fixture.memory, fixture.delivery);
    const { calls, dependencies } = externalPublicationDependencies(fixture);

    expect(await handleChannelDelivery(fixture.event, dependencies)).toEqual({
      batchItemFailures: [],
    });

    expect(calls).toEqual(["reserve", "fence", "publish:sent"]);
    expect(fixture.connector.requests).toEqual([]);
    expect(persistedDelivery(fixture.memory)?.data).toMatchObject({
      providerMessageId: "stream-1",
      status: "sent",
    });
  });

  test("keeps a superseded streamed response out of history", async () => {
    const fixture = teamsDeliveryFixture(externalDelivery);
    addTeamsStream(fixture.memory, fixture.delivery);
    const { calls, dependencies } = externalPublicationDependencies(fixture, "superseded");

    expect(await handleChannelDelivery(fixture.event, dependencies)).toEqual({
      batchItemFailures: [],
    });

    expect(calls).toEqual(["reserve", "fence", "release"]);
    expect(persistedDelivery(fixture.memory)?.data).toMatchObject({
      lastError: expect.stringContaining("superseded"),
      status: "failed",
    });
  });

  test("does not hold the publication barrier while the stream outcome is unresolved", async () => {
    const fixture = teamsDeliveryFixture(externalDelivery);
    addTeamsStream(fixture.memory, fixture.delivery, { status: "streaming" });
    const { calls, dependencies } = externalPublicationDependencies(fixture);

    expect(await handleChannelDelivery(fixture.event, dependencies)).toEqual({
      batchItemFailures: [{ itemIdentifier: "queue-message-1" }],
    });
    expect(calls).toEqual([]);

    expect(await handleChannelDelivery(finalReceive(fixture.event), dependencies)).toEqual({
      batchItemFailures: [],
    });
    expect(calls).toEqual(["release"]);
    expect(fixture.connector.requests).toEqual([]);
  });
});
