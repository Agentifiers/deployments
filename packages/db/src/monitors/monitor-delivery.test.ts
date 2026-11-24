import { describe, expect, test } from "bun:test";
import { DEFAULT_TABLE_NAMES } from "../client-types.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { ALERT_EMAIL_CLAIM_TIMEOUT_MS, makeAlertDeliveryPersistence } from "./delivery.ts";
import { makeAlertHistory } from "./history.ts";
import {
  ENVIRONMENT_SCOPE,
  ORGANIZATION_ID,
  monitorHarness,
  testUlid,
} from "./monitor-test-support.ts";

type Harness = ReturnType<typeof monitorHarness>;

function seedMember(
  harness: Harness,
  input: {
    readonly email?: string;
    readonly role: "admin" | "billing" | "member" | "owner" | "viewer";
    readonly status?: "active" | "removed";
  },
) {
  const principalId = testUlid();
  const at = harness.now().toISOString();
  harness.fake.put(
    DEFAULT_TABLE_NAMES.control,
    withCanonicalRecordKeys({
      data: {
        createdAt: at,
        id: principalId,
        kind: "human",
        ...(input.email ? { primaryEmail: input.email } : {}),
        status: "active",
        updatedAt: at,
        version: 1,
      },
      itemType: "principal",
    }),
  );
  harness.fake.put(
    DEFAULT_TABLE_NAMES.control,
    withCanonicalRecordKeys({
      data: {
        createdAt: at,
        organizationId: ORGANIZATION_ID,
        principalId,
        role: input.role,
        status: input.status ?? "active",
        updatedAt: at,
        version: 1,
      },
      itemType: "organization-member",
    }),
  );
  return principalId;
}

describe("alert email delivery", () => {
  test("recipients are active members by role or by name who can receive email and have not opted out", async () => {
    const harness = monitorHarness();
    const owner = seedMember(harness, { email: "owner@example.com", role: "owner" });
    const named = seedMember(harness, { email: "named@example.com", role: "member" });
    seedMember(harness, { email: "member@example.com", role: "member" });
    seedMember(harness, { email: "removed@example.com", role: "owner", status: "removed" });
    seedMember(harness, { role: "owner" });
    const optedOut = seedMember(harness, { email: "quiet@example.com", role: "owner" });
    const mutedThis = seedMember(harness, { email: "muted@example.com", role: "owner" });

    const monitor = await harness.monitors.create({
      condition: { kind: "run-failures", threshold: 1, windowMinutes: 15 },
      name: "Runs failing",
      notify: { emailPrincipalIds: [named], emailRoles: ["owner"], webhooks: false },
      organizationId: ORGANIZATION_ID,
      scope: ENVIRONMENT_SCOPE,
    });
    const history = makeAlertHistory({ database: harness.database, now: harness.now });
    await history.putPreference({
      email: "none",
      mutedMonitorIds: [],
      organizationId: ORGANIZATION_ID,
      principalId: optedOut,
    });
    await history.putPreference({
      email: "all",
      mutedMonitorIds: [monitor.data.id],
      organizationId: ORGANIZATION_ID,
      principalId: mutedThis,
    });

    const delivery = makeAlertDeliveryPersistence({ database: harness.database, now: harness.now });
    const recipients = await delivery.recipients(monitor);
    expect(recipients.map((recipient) => recipient.email).toSorted()).toEqual([
      "named@example.com",
      "owner@example.com",
    ]);
    expect(recipients.find((recipient) => recipient.principalId === owner)).toBeDefined();
  });

  test("an email is claimed once per event and member, and a stale claim may be retaken", async () => {
    const harness = monitorHarness();
    const delivery = makeAlertDeliveryPersistence({ database: harness.database, now: harness.now });
    const input = { eventId: testUlid(), organizationId: ORGANIZATION_ID, principalId: testUlid() };

    const [first, second] = await Promise.all([
      delivery.claimEmail(input),
      delivery.claimEmail(input),
    ]);
    expect([first.kind, second.kind].toSorted()).toEqual(["claimed", "held"]);
    expect((await delivery.claimEmail(input)).kind).toBe("held");

    harness.advance(ALERT_EMAIL_CLAIM_TIMEOUT_MS / 60_000 + 1);
    const retaken = await delivery.claimEmail(input);
    expect(retaken.kind).toBe("claimed");
    if (retaken.kind === "claimed") await retaken.release("sent");
    harness.advance(60);
    expect((await delivery.claimEmail(input)).kind).toBe("done");
  });

  test("a failed send may be retried at once, and a sent email never again", async () => {
    const harness = monitorHarness();
    const delivery = makeAlertDeliveryPersistence({ database: harness.database, now: harness.now });
    const input = { eventId: testUlid(), organizationId: ORGANIZATION_ID, principalId: testUlid() };
    const first = await delivery.claimEmail(input);
    if (first.kind !== "claimed") throw new Error("expected a claim");
    await first.release("failed");
    const second = await delivery.claimEmail(input);
    if (second.kind !== "claimed") throw new Error("expected a retaken claim");
    await second.release("sent");
    expect((await delivery.claimEmail(input)).kind).toBe("done");
  });

  test("a sender that keeps crashing gives up after the attempt budget", async () => {
    const harness = monitorHarness();
    const delivery = makeAlertDeliveryPersistence({ database: harness.database, now: harness.now });
    const input = { eventId: testUlid(), organizationId: ORGANIZATION_ID, principalId: testUlid() };
    const kinds: string[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      kinds.push((await delivery.claimEmail(input)).kind);
      harness.advance(ALERT_EMAIL_CLAIM_TIMEOUT_MS / 60_000 + 1);
    }
    expect(kinds).toEqual(["claimed", "claimed", "claimed", "claimed", "claimed", "done", "done"]);
  });

  test("a test send emits a test alert addressed to the member who asked, outside incident history", async () => {
    const harness = monitorHarness();
    const monitor = await harness.monitors.create({
      condition: { kind: "run-failures", threshold: 1, windowMinutes: 15 },
      name: "Runs failing",
      notify: { emailPrincipalIds: [], emailRoles: ["owner"], webhooks: true },
      organizationId: ORGANIZATION_ID,
      scope: ENVIRONMENT_SCOPE,
    });
    const requester = testUlid();
    await harness.monitors.sendTest({
      monitorId: monitor.data.id,
      organizationId: ORGANIZATION_ID,
      requestedByPrincipalId: requester,
    });
    expect(harness.alertEvents()).toMatchObject([
      {
        eventType: "alert.test",
        payload: { deliverWebhooks: true, emailPrincipalId: requester, monitorId: monitor.data.id },
      },
    ]);
    expect(harness.incidents()).toEqual([]);
  });
});
