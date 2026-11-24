import { describe, expect, test } from "bun:test";

import {
  CHANNEL_EVENT_TYPES,
  PROVIDER_EVENT_TYPES,
  makeChannelSemanticEventRecord,
  makeProviderSemanticEventRecord,
  type Ulid,
} from "./index.ts";

const ID = "01J00000000000000000000000" as Ulid;

describe("channel and provider semantic events", () => {
  test("uses typed event names in the canonical outbox envelope", () => {
    const channel = makeChannelSemanticEventRecord({
      aggregateId: ID,
      aggregateType: "channel-delivery",
      aggregateVersion: 1,
      eventId: ID,
      eventType: "channel.delivery.sent",
      occurredAt: "2026-07-21T00:00:00.000Z",
      organizationId: ID,
      payload: { channel: "slack", provider: "slack_edge" },
    });
    const provider = makeProviderSemanticEventRecord({
      aggregateId: ID,
      aggregateType: "provider-connection",
      aggregateVersion: 1,
      eventId: ID,
      eventType: "provider.connection.verified",
      occurredAt: "2026-07-21T00:00:00.000Z",
      organizationId: ID,
      payload: { providerKey: "slack" },
    });
    expect(CHANNEL_EVENT_TYPES).toContain("channel.delivery.sent");
    expect(CHANNEL_EVENT_TYPES).toContain("channel.delivery.retrying");
    expect(PROVIDER_EVENT_TYPES).toContain("provider.connection.verified");
    expect(PROVIDER_EVENT_TYPES).toContain("provider.connection.refreshed");
    expect(PROVIDER_EVENT_TYPES).toContain("provider.application.credentials.rotated");
    expect(channel.data.eventType).toBe("channel.delivery.sent");
    expect(provider.data.eventType).toBe("provider.connection.verified");
  });
});
