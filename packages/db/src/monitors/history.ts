import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { PersistenceError } from "../persistence-types.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import {
  AlertNotificationPreferenceRecord,
  type MonitorIncidentRecord,
} from "../records/monitors.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { incidentKey } from "./persistence.ts";

type Incident = MonitorIncidentRecord;
type Preference = AlertNotificationPreferenceRecord;

const decodePreference = Schema.decodeUnknownSync(AlertNotificationPreferenceRecord);
const MAX_PREFERENCE_WRITE_ATTEMPTS = 4;

function invalidCursor() {
  return new PersistenceError("invalid-input", "invalid_cursor", "The cursor is invalid.");
}

function encodeCursor(value: Readonly<Record<string, unknown>>) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** A cursor is bound to the index partition it was issued for. */
function decodeCursor(cursor: string, partition: string): Record<string, unknown> {
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw invalidCursor();
  }
  if (decoded.gsi1pk !== partition && decoded.gsi2pk !== partition) throw invalidCursor();
  return decoded;
}

function preferenceKey(organizationId: Ulid, principalId: Ulid) {
  return { pk: key("ORG", organizationId), sk: key("ALERT-NOTIFICATION-PREFERENCE", principalId) };
}

export interface AlertHistory {
  readonly getIncident: (
    organizationId: Ulid,
    monitorId: Ulid,
    incidentId: Ulid,
  ) => Promise<Incident>;
  readonly listIncidents: (input: {
    readonly cursor?: string;
    readonly environmentId?: Ulid;
    readonly limit: number;
    readonly organizationId: Ulid;
  }) => Promise<{ readonly items: readonly Incident[]; readonly nextCursor?: string }>;
  readonly preference: (organizationId: Ulid, principalId: Ulid) => Promise<Preference | undefined>;
  readonly putPreference: (input: {
    readonly email: "all" | "none";
    readonly mutedMonitorIds: readonly Ulid[];
    readonly organizationId: Ulid;
    readonly principalId: Ulid;
  }) => Promise<Preference>;
}

/** Alert history reads and each member's own alert email preference. */
export function makeAlertHistory(dependencies: {
  readonly database: DynamoDatabaseService;
  readonly now?: () => Date;
}): AlertHistory {
  const { database } = dependencies;
  const now = dependencies.now ?? (() => new Date());

  async function readPreference(organizationId: Ulid, principalId: Ulid) {
    const record = await database.getRecord(
      "control",
      preferenceKey(organizationId, principalId),
      true,
    );
    return record?.itemType === "alert-notification-preference" ? record : undefined;
  }

  return {
    async getIncident(organizationId, monitorId, incidentId) {
      const record = await database.getRecord(
        "events",
        incidentKey(organizationId, monitorId, incidentId),
        true,
      );
      if (record?.itemType !== "monitor-incident") {
        throw new PersistenceError("not-found", "incident_not_found", "The alert was not found.");
      }
      return record;
    },

    async listIncidents(input) {
      const index = input.environmentId ? "gsi2" : "gsi1";
      const partition = input.environmentId
        ? key("ENV", input.environmentId, "MONITOR-INCIDENTS")
        : key("ORG", input.organizationId, "MONITOR-INCIDENTS");
      const page = await database.queryRecords("events", {
        ...(input.cursor ? { ExclusiveStartKey: decodeCursor(input.cursor, partition) } : {}),
        ExpressionAttributeNames: { "#pk": `${index}pk` },
        ExpressionAttributeValues: { ":pk": partition },
        IndexName: index,
        KeyConditionExpression: "#pk = :pk",
        Limit: input.limit,
        ScanIndexForward: false,
      });
      return {
        items: page.items.filter(
          (item): item is Incident =>
            item.itemType === "monitor-incident" &&
            item.data.organizationId === input.organizationId,
        ),
        ...(page.lastEvaluatedKey ? { nextCursor: encodeCursor(page.lastEvaluatedKey) } : {}),
      };
    },

    preference: readPreference,

    async putPreference(input) {
      for (let attempt = 0; attempt < MAX_PREFERENCE_WRITE_ATTEMPTS; attempt += 1) {
        const stored = await readPreference(input.organizationId, input.principalId);
        const timestamp = now().toISOString();
        const next = decodePreference(
          withCanonicalRecordKeys({
            data: {
              createdAt: stored?.data.createdAt ?? timestamp,
              email: input.email,
              mutedMonitorIds: [...new Set(input.mutedMonitorIds)].toSorted(),
              organizationId: input.organizationId,
              principalId: input.principalId,
              updatedAt: timestamp,
              version: (stored?.data.version ?? 0) + 1,
            },
            itemType: "alert-notification-preference" as const,
          }),
        );
        try {
          await database.transactWrite([
            stored
              ? { kind: "put", previousRecord: stored, record: next }
              : { kind: "put", record: next },
          ]);
          return next;
        } catch (cause) {
          if (!isDatabaseWriteConflict(cause)) throw cause;
        }
      }
      throw new PersistenceError(
        "conflict",
        "preference_changed",
        "Your notification settings changed at the same time. Try again.",
      );
    },
  };
}
