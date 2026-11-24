import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { createHash } from "node:crypto";
import { Ulid } from "./ids.ts";
import { key, Keys } from "./keys.ts";
import { canonicalRecordKeys } from "./record-keys.ts";
import { InboxMessageThreadAliasTombstoneRecord } from "./records/conversation-erasure.ts";

const ORG_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const BILLING_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const MESSAGE_1_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const MESSAGE_2_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAZ");

describe("keys", () => {
  test("orders message sequences lexicographically", () => {
    const first = key("MESSAGE", "9".padStart(16, "0"), MESSAGE_1_ID);
    const second = key("MESSAGE", "10".padStart(16, "0"), MESSAGE_2_ID);
    expect(first < second).toBe(true);
  });

  test("escapes untrusted key parts", () => {
    const result = Keys.control.uniqueClaim("organization#slug", "request/one");
    expect(result.pk).toBe("UNIQUE#organization%23slug");
    expect(result.sk).toBe("VALUE#request%2Fone");
  });

  test("uses semantic identities for coordination records", () => {
    const runtimeLease = canonicalRecordKeys(
      {
        data: { id: ORG_ID, leaseKey: "scheduler/global" },
        itemType: "runtime-lease",
      },
      "execution",
    );
    const scheduleFire = canonicalRecordKeys(
      {
        data: {
          fireKey: "2026-07-20T12:00:00.000Z",
          id: BILLING_ID,
          scheduleId: ORG_ID,
        },
        itemType: "schedule-fire",
      },
      "execution",
    );

    expect(runtimeLease.pk).toBe(`RUNTIME-LEASE#${ORG_ID}`);
    expect(runtimeLease.sk).toBe("RUNTIME-LEASE#scheduler%2Fglobal");
    expect(scheduleFire.sk).toBe(`SCHEDULE-FIRE#${ORG_ID}#2026-07-20T12%3A00%3A00.000Z`);
  });

  test("partitions inbound thread routes by source binding", () => {
    const route = canonicalRecordKeys(
      {
        data: {
          id: "deployment/thread",
          organizationId: ORG_ID,
          sourceId: MESSAGE_1_ID,
        },
        itemType: "inbound-thread-route",
      },
      "execution",
    );

    expect(route.pk).toBe(`ORG#${ORG_ID}#SOURCE#${MESSAGE_1_ID}`);
    expect(route.sk).toBe("INBOUND-THREAD-ROUTE#deployment%2Fthread");
  });

  test("indexes active platform-agent bindings by inbox", () => {
    const binding = canonicalRecordKeys(
      {
        data: {
          bindingType: "platform_agent",
          environmentId: BILLING_ID,
          id: MESSAGE_1_ID,
          inboxId: MESSAGE_2_ID,
          organizationId: ORG_ID,
          status: "active",
          updatedAt: "2026-07-26T00:00:00.000Z",
        },
        itemType: "inbox-binding",
      },
      "control",
    );

    expect(binding.gsi1pk).toBe(`ENV#${BILLING_ID}#INBOX#${MESSAGE_2_ID}#BINDINGS`);
    expect(binding.gsi1sk).toBe(
      `INBOX-BINDING#active#platform_agent#2026-07-26T00%3A00%3A00.000Z#${MESSAGE_1_ID}`,
    );
  });

  test("registers semantic identities for records without an id field", () => {
    const providerDefinition = canonicalRecordKeys(
      {
        data: { key: "github" },
        itemType: "provider-definition",
      },
      "control",
    );
    const memoryIndexState = canonicalRecordKeys(
      {
        data: { memoryId: ORG_ID, organizationId: ORG_ID },
        itemType: "memory-index-state",
      },
      "control",
    );

    expect(providerDefinition.sk).toBe("PROVIDER-DEFINITION#github");
    expect(memoryIndexState.sk).toBe(`MEMORY-INDEX-STATE#${ORG_ID}`);
  });

  test("uses idempotency keys for metering and provider mutation claims", () => {
    const meterEvent = canonicalRecordKeys(
      {
        data: {
          id: ORG_ID,
          idempotencyKey: "meter/request-1",
          organizationId: ORG_ID,
        },
        itemType: "meter-event",
      },
      "usage",
    );
    const providerMutation = canonicalRecordKeys(
      {
        data: {
          id: BILLING_ID,
          idempotencyKey: "mutation/request-1",
          organizationId: ORG_ID,
          runId: MESSAGE_1_ID,
          toolCallId: MESSAGE_2_ID,
        },
        itemType: "provider-mutation-claim",
      },
      "execution",
    );

    expect(meterEvent.sk).toBe("METER-EVENT#meter%2Frequest-1");
    expect(providerMutation.sk).toBe(
      `PROVIDER-MUTATION-CLAIM#${MESSAGE_1_ID}#${createHash("sha256").update("mutation/request-1").digest("hex")}`,
    );
  });

  test("indexes tenancy bootstrap relationships and principal idempotency", () => {
    const timestamp = "2026-07-25T00:00:00.000Z";
    const organization = canonicalRecordKeys(
      {
        data: {
          id: ORG_ID,
          status: "active",
          updatedAt: timestamp,
        },
        itemType: "organization",
      },
      "control",
    );
    const membership = canonicalRecordKeys(
      {
        data: {
          organizationId: ORG_ID,
          principalId: BILLING_ID,
          status: "active",
          updatedAt: timestamp,
        },
        itemType: "organization-member",
      },
      "control",
    );
    const environment = canonicalRecordKeys(
      {
        data: {
          id: MESSAGE_1_ID,
          organizationId: ORG_ID,
          projectId: BILLING_ID,
          status: "active",
          updatedAt: timestamp,
        },
        itemType: "environment",
      },
      "control",
    );
    const idempotency = canonicalRecordKeys(
      {
        data: {
          idempotencyKey: "bootstrap/request",
          principalId: BILLING_ID,
        },
        itemType: "idempotency",
      },
      "events",
    );

    expect(organization.gsi1pk).toBe("GLOBAL#ORGANIZATIONS");
    expect(membership.gsi2pk).toBe(`PRINCIPAL#${BILLING_ID}`);
    expect(environment.gsi2pk).toBe(`PROJECT#${BILLING_ID}`);
    expect(idempotency.pk).toBe(`PRINCIPAL#${BILLING_ID}#IDEMPOTENCY`);
  });

  test("orders scheduled inbox messages by their due time", () => {
    const scheduledAt = "2026-07-25T01:00:00.000Z";
    const scheduled = canonicalRecordKeys(
      {
        data: {
          environmentId: MESSAGE_1_ID,
          id: MESSAGE_2_ID,
          inboxId: BILLING_ID,
          organizationId: ORG_ID,
          projectId: BILLING_ID,
          scheduledAt,
          status: "scheduled",
          updatedAt: "2026-07-20T00:00:00.000Z",
        },
        itemType: "inbox-message",
      },
      "execution",
    );

    expect(scheduled.gsi2pk).toBe(`ENV#${MESSAGE_1_ID}`);
    expect(scheduled.gsi2sk).toBe(
      `INBOX-MESSAGE#scheduled#2026-07-25T01%3A00%3A00.000Z#${MESSAGE_2_ID}`,
    );
  });

  test("orders inbox message listing records by message creation time before ID", () => {
    const createdAt = "2026-07-25T02:00:00.000Z";
    const listing = canonicalRecordKeys(
      {
        data: {
          createdAt,
          environmentId: MESSAGE_1_ID,
          id: MESSAGE_2_ID,
          inboxId: BILLING_ID,
          organizationId: ORG_ID,
          projectId: BILLING_ID,
        },
        itemType: "inbox-message-created-index",
      },
      "execution",
    );

    expect(listing.pk).toBe(`ORG#${ORG_ID}#INBOX#${BILLING_ID}`);
    expect(listing.sk).toBe(
      `INBOX-MESSAGE-CREATED-INDEX#2026-07-25T02%3A00%3A00.000Z#${MESSAGE_2_ID}`,
    );
  });

  test("orders Agent Email control and draft listings by resource creation time", () => {
    const createdAt = "2026-07-25T02:00:00.000Z";
    const controlListing = canonicalRecordKeys(
      {
        data: {
          createdAt,
          environmentId: MESSAGE_1_ID,
          id: MESSAGE_2_ID,
          organizationId: ORG_ID,
          projectId: BILLING_ID,
          resourceType: "inbox-domain",
        },
        itemType: "inbox-control-created-index",
      },
      "control",
    );
    const draftListing = canonicalRecordKeys(
      {
        data: {
          createdAt,
          environmentId: MESSAGE_1_ID,
          id: MESSAGE_2_ID,
          inboxId: BILLING_ID,
          organizationId: ORG_ID,
          projectId: BILLING_ID,
        },
        itemType: "inbox-draft-created-index",
      },
      "execution",
    );

    expect(controlListing.pk).toBe(`ORG#${ORG_ID}#ENV#${MESSAGE_1_ID}`);
    expect(controlListing.sk).toBe(
      `INBOX-CONTROL-CREATED-INDEX#inbox-domain#2026-07-25T02%3A00%3A00.000Z#${MESSAGE_2_ID}`,
    );
    expect(draftListing.pk).toBe(`ORG#${ORG_ID}#INBOX#${BILLING_ID}`);
    expect(draftListing.sk).toBe(
      `INBOX-DRAFT-CREATED-INDEX#2026-07-25T02%3A00%3A00.000Z#${MESSAGE_2_ID}`,
    );
  });

  test("orders inbox thread listing records by thread creation time before ID", () => {
    const createdAt = "2026-07-25T02:00:00.000Z";
    const listing = canonicalRecordKeys(
      {
        data: {
          createdAt,
          environmentId: MESSAGE_1_ID,
          id: MESSAGE_2_ID,
          inboxId: BILLING_ID,
          organizationId: ORG_ID,
          projectId: BILLING_ID,
        },
        itemType: "inbox-thread-created-index",
      },
      "execution",
    );

    expect(listing.pk).toBe(`ORG#${ORG_ID}#INBOX#${BILLING_ID}`);
    expect(listing.sk).toBe(
      `INBOX-THREAD-CREATED-INDEX#2026-07-25T02%3A00%3A00.000Z#${MESSAGE_2_ID}`,
    );
  });

  test("orders thread messages without scanning the inbox aggregate", () => {
    const createdAt = "2026-07-25T02:00:00.000Z";
    const listing = canonicalRecordKeys(
      {
        data: {
          createdAt,
          environmentId: MESSAGE_1_ID,
          id: MESSAGE_2_ID,
          inboxId: BILLING_ID,
          organizationId: ORG_ID,
          projectId: BILLING_ID,
          threadId: MESSAGE_1_ID,
        },
        itemType: "inbox-message-thread-index",
      },
      "execution",
    );

    expect(listing.pk).toBe(`ORG#${ORG_ID}#THREAD#${MESSAGE_1_ID}`);
    expect(listing.sk).toBe(
      `INBOX-MESSAGE-THREAD-INDEX#2026-07-25T02%3A00%3A00.000Z#${MESSAGE_2_ID}`,
    );
  });

  test("keeps pending inbox content cleanup bounded to its environment and message", () => {
    const cleanup = canonicalRecordKeys(
      {
        data: {
          createdAt: "2026-07-25T02:00:00.000Z",
          environmentId: MESSAGE_1_ID,
          id: MESSAGE_2_ID,
          organizationId: ORG_ID,
          projectId: BILLING_ID,
          resourceId: BILLING_ID,
          resourceType: "message",
          status: "pending",
        },
        itemType: "inbox-content-cleanup",
      },
      "execution",
    );

    expect(cleanup.pk).toBe(`ORG#${ORG_ID}#RESOURCE#${BILLING_ID}`);
    expect(cleanup.sk).toBe(`INBOX-CONTENT-CLEANUP#${MESSAGE_2_ID}`);
    expect(cleanup.gsi1pk).toBe(`INBOX-CONTENT-CLEANUP#${ORG_ID}#${BILLING_ID}#${MESSAGE_1_ID}`);
    expect(cleanup.gsi1sk).toBe(`2026-07-25T02%3A00%3A00.000Z#${MESSAGE_2_ID}`);
  });

  test("scopes Internet Message-ID thread aliases to an inbox using a bounded hash", () => {
    const internetMessageId = "<outbound@example.com>";
    const alias = canonicalRecordKeys(
      {
        data: {
          inboxId: BILLING_ID,
          internetMessageId,
          organizationId: ORG_ID,
        },
        itemType: "inbox-message-thread-alias",
      },
      "execution",
    );

    expect(alias.pk).toBe(`ORG#${ORG_ID}#INBOX#${BILLING_ID}`);
    expect(alias.sk).toBe(
      `INBOX-MESSAGE-THREAD-ALIAS#${createHash("sha256").update(internetMessageId).digest("hex")}`,
    );
  });

  test("keys an erased alias's tombstone by the alias hash and refuses a raw Message-ID", () => {
    const internetMessageIdHash =
      "00f3b77c83d4598bfacd27fbbc69baeadb747a1e0bdf51db91b2595a167088a6";
    const data = {
      environmentId: MESSAGE_1_ID,
      inboxId: BILLING_ID,
      inboxThreadId: MESSAGE_2_ID,
      internetMessageIdHash,
      organizationId: ORG_ID,
      projectId: MESSAGE_1_ID,
    };
    const tombstone = canonicalRecordKeys(
      { data, itemType: "inbox-message-thread-alias-tombstone" },
      "execution",
    );
    const decode = Schema.decodeUnknownSync(InboxMessageThreadAliasTombstoneRecord);

    expect(tombstone.pk).toBe(`ORG#${ORG_ID}#INBOX#${BILLING_ID}`);
    expect(tombstone.sk).toBe(`INBOX-MESSAGE-THREAD-ALIAS-TOMBSTONE#${internetMessageIdHash}`);
    expect(
      decode({ data, itemType: "inbox-message-thread-alias-tombstone", ...tombstone }).data,
    ).toEqual(data);
    expect(() =>
      decode({
        data: { ...data, internetMessageIdHash: "<outbound@example.com>" },
        itemType: "inbox-message-thread-alias-tombstone",
        ...tombstone,
      }),
    ).toThrow();
  });
});
