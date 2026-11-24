import { Schema } from "effect";
import { DEFAULT_TABLE_NAMES } from "../client-types.ts";
import { makeDynamoDatabase } from "../dynamo-database.ts";
import { Ulid } from "../ids.ts";
import type { SemanticEventData } from "../records/events.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import type { MonitorCondition, MonitorNotify } from "../records/monitors.ts";
import { fakeDynamoDocumentClient } from "../testing/dynamo-document-client.fixture.ts";
import type { MonitorEvaluationDependencies, MonitorObserver } from "./evaluation.ts";
import { makeMonitorPersistence } from "./persistence.ts";

type SemanticEvent = typeof SemanticEventData.Type;

const ulid = Schema.decodeUnknownSync(Ulid);
let sequence = 0;

/** Monotonic, schema-valid ULIDs; tests compare them only for equality. */
export function testUlid(): Ulid {
  sequence += 1;
  return ulid(`01K0000000000000000${String(sequence).padStart(7, "0")}`);
}

export const ORGANIZATION_ID = ulid("01K00000000000000000000RG1");
export const PROJECT_ID = ulid("01K00000000000000000000PJ1");
export const ENVIRONMENT_ID = ulid("01K00000000000000000000EN1");
export const OTHER_ENVIRONMENT_ID = ulid("01K00000000000000000000EN2");
export const DEPLOYMENT_ID = ulid("01K00000000000000000000DP1");

export const ENVIRONMENT_SCOPE = {
  environmentId: ENVIRONMENT_ID,
  kind: "environment",
  projectId: PROJECT_ID,
} as const;

export const OWNERS_BY_EMAIL: MonitorNotify = {
  emailPrincipalIds: [],
  emailRoles: ["owner"],
  webhooks: true,
};

/**
 * A monitor store on the in-memory DynamoDB document client, which evaluates the real condition
 * expressions, so version conflicts and create-only puts behave as they do in DynamoDB.
 */
export function monitorHarness(start = "2026-11-02T10:00:00.000Z") {
  const fake = fakeDynamoDocumentClient();
  // Tenant writes are fenced on the organization record existing.
  fake.put(
    DEFAULT_TABLE_NAMES.control,
    withCanonicalRecordKeys({
      data: {
        createdAt: start,
        id: ORGANIZATION_ID,
        name: "Organization",
        slug: "organization",
        status: "active",
        updatedAt: start,
        version: 1,
      },
      itemType: "organization",
    }),
  );
  const database = makeDynamoDatabase(fake.client, DEFAULT_TABLE_NAMES);
  let clock = new Date(start);
  const monitors = makeMonitorPersistence({ database, generateId: testUlid, now: () => clock });
  const observers: Partial<Record<MonitorCondition["kind"], MonitorObserver>> = {};
  const dependencies: MonitorEvaluationDependencies = {
    monitors,
    now: () => clock,
    observe: observers,
  };
  const items = (itemType: string) =>
    fake.items(DEFAULT_TABLE_NAMES.events).filter((item) => item.itemType === itemType);
  return {
    advance(minutes: number) {
      clock = new Date(clock.getTime() + minutes * 60_000);
    },
    database,
    dependencies,
    fake,
    /** Alert semantic events in commit order. */
    alertEvents: () =>
      items("semantic-event")
        .map((item) => item.data as SemanticEvent)
        .filter((event) => event.eventType.startsWith("alert."))
        .toSorted((left, right) => left.eventId.localeCompare(right.eventId)),
    incidents: () =>
      items("monitor-incident").map(
        (item) => item.data as { readonly status: string; readonly timeline: readonly unknown[] },
      ),
    monitors,
    now: () => clock,
    observers,
  };
}

export function semanticEvent(
  eventType: string,
  overrides: Partial<SemanticEvent> & { readonly occurredAt: string },
): SemanticEvent {
  return {
    aggregateId: testUlid(),
    aggregateType: "run",
    aggregateVersion: 2,
    environmentId: ENVIRONMENT_ID,
    eventId: testUlid(),
    eventType,
    organizationId: ORGANIZATION_ID,
    payload: {},
    projectId: PROJECT_ID,
    ...overrides,
  };
}
