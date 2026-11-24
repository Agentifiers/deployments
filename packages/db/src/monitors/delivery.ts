import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { AlertEmailDeliveryRecord, type MonitorRecord } from "../records/monitors.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import { makeAlertHistory } from "./history.ts";

const decodeDelivery = Schema.decodeUnknownSync(AlertEmailDeliveryRecord);

/** Alert email claims outlive every retry of the event that produced them. */
const DELIVERY_RETENTION_MS = 7 * 24 * 60 * 60_000;
/**
 * A claim older than this was taken by a sender that crashed or timed out; it may be retaken.
 * It must be shorter than Lambda's first async retry (one minute), so the retry of an
 * invocation that died between claim and send finds the claim stale and sends the email. A
 * claim covers one SES request, which the sender bounds well below this.
 */
export const ALERT_EMAIL_CLAIM_TIMEOUT_MS = 45_000;
export const MAX_ALERT_EMAIL_ATTEMPTS = 5;

/** One member who receives an alert's email. */
export interface AlertRecipient {
  readonly displayName?: string;
  readonly email: string;
  readonly principalId: Ulid;
}

export type AlertEmailClaim =
  | {
      readonly kind: "claimed";
      /** `failed` lets the next delivery of the event retake the claim at once. */
      readonly release: (outcome: "failed" | "sent") => Promise<void>;
    }
  /** Sent, or given up on after the attempt budget. */
  | { readonly kind: "done" }
  /** Another sender holds a fresh claim; retry later, since that sender may die before sending. */
  | { readonly kind: "held" };

export interface AlertDeliveryPersistence {
  /**
   * Claims one alert event's email to one member before the send. `done` means it was sent or
   * given up on, so a retried event sends nothing twice; `held` means another sender is on it.
   */
  readonly claimEmail: (input: {
    readonly eventId: Ulid;
    readonly organizationId: Ulid;
    readonly principalId: Ulid;
  }) => Promise<AlertEmailClaim>;
  /**
   * Active members the monitor names, by role or by principal, who have an email address and have
   * not turned the email off for everything or for this monitor.
   */
  readonly recipients: (monitor: MonitorRecord) => Promise<readonly AlertRecipient[]>;
  /** One active member, if they can receive alert email, for a test send to oneself. */
  readonly member: (organizationId: Ulid, principalId: Ulid) => Promise<AlertRecipient | undefined>;
}

/** Recipient resolution and per-member send claims for the alert email worker. */
export function makeAlertDeliveryPersistence(dependencies: {
  readonly database: DynamoDatabaseService;
  readonly now?: () => Date;
}): AlertDeliveryPersistence {
  const { database } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const history = makeAlertHistory({ database, now });

  async function activeMembers(organizationId: Ulid) {
    const members: { principalId: Ulid; role: string }[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const page = await database.queryRecords("control", {
        ConsistentRead: true,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        ExpressionAttributeNames: { "#partition": "pk", "#sort": "sk" },
        ExpressionAttributeValues: {
          ":partition": key("ORG", organizationId),
          ":prefix": `${key("ORGANIZATION-MEMBER")}#`,
        },
        KeyConditionExpression: "#partition = :partition AND begins_with(#sort, :prefix)",
        Limit: 100,
      });
      for (const item of page.items) {
        if (item.itemType === "organization-member" && item.data.status === "active") {
          members.push({ principalId: item.data.principalId, role: item.data.role });
        }
      }
      cursor = page.lastEvaluatedKey;
    } while (cursor);
    return members;
  }

  async function reachable(organizationId: Ulid, principalId: Ulid, monitorId?: Ulid) {
    const [principal, preference] = await Promise.all([
      database.getRecord(
        "control",
        { pk: key("PRINCIPAL", principalId), sk: key("PRINCIPAL", principalId) },
        true,
      ),
      history.preference(organizationId, principalId),
    ]);
    if (
      principal?.itemType !== "principal" ||
      principal.data.kind !== "human" ||
      principal.data.status !== "active" ||
      !principal.data.primaryEmail
    ) {
      return undefined;
    }
    if (
      monitorId !== undefined &&
      (preference?.data.email === "none" || preference?.data.mutedMonitorIds.includes(monitorId))
    ) {
      return undefined;
    }
    return {
      ...(principal.data.displayName ? { displayName: principal.data.displayName } : {}),
      email: principal.data.primaryEmail,
      principalId,
    } satisfies AlertRecipient;
  }

  return {
    async recipients(monitor) {
      const { emailPrincipalIds, emailRoles } = monitor.data.notify;
      if (emailPrincipalIds.length === 0 && emailRoles.length === 0) return [];
      const named = new Set<string>(emailPrincipalIds);
      const roles = new Set<string>(emailRoles);
      const chosen = (await activeMembers(monitor.data.organizationId)).filter(
        (member) => named.has(member.principalId) || roles.has(member.role),
      );
      const resolved = await Promise.all(
        chosen.map((member) =>
          reachable(monitor.data.organizationId, member.principalId, monitor.data.id),
        ),
      );
      return resolved.filter((recipient) => recipient !== undefined);
    },

    async member(organizationId, principalId) {
      const membership = await database.getRecord(
        "control",
        { pk: key("ORG", organizationId), sk: key("ORGANIZATION-MEMBER", principalId) },
        true,
      );
      if (membership?.itemType !== "organization-member" || membership.data.status !== "active") {
        return undefined;
      }
      return reachable(organizationId, principalId);
    },

    async claimEmail({ eventId, organizationId, principalId }) {
      const recordKey = {
        pk: key("ORG", organizationId),
        sk: key("ALERT-EMAIL-DELIVERY", eventId, principalId),
      };
      const previous = await database.getRecord("events", recordKey, true);
      const stored = previous?.itemType === "alert-email-delivery" ? previous : undefined;
      const at = now();
      const retakeable =
        stored === undefined ||
        stored.data.status === "failed" ||
        (stored.data.status === "claimed" &&
          at.getTime() - Date.parse(stored.data.claimedAt) >= ALERT_EMAIL_CLAIM_TIMEOUT_MS);
      if (!retakeable) return { kind: stored.data.status === "claimed" ? "held" : "done" };
      const attempts = (stored?.data.attempts ?? 0) + 1;
      const expiresAt = new Date(
        stored ? Date.parse(stored.data.expiresAt) : at.getTime() + DELIVERY_RETENTION_MS,
      ).toISOString();
      const claim = decodeDelivery(
        withCanonicalRecordKeys({
          data: {
            attempts,
            claimedAt: at.toISOString(),
            eventId,
            expiresAt,
            organizationId,
            principalId,
            status: attempts > MAX_ALERT_EMAIL_ATTEMPTS ? "abandoned" : "claimed",
            version: (stored?.data.version ?? 0) + 1,
          },
          itemType: "alert-email-delivery" as const,
          ttl: Math.floor(Date.parse(expiresAt) / 1_000),
        }),
      );
      try {
        await database.transactWrite([
          stored
            ? { kind: "put", previousRecord: stored, record: claim }
            : { kind: "put", record: claim },
        ]);
      } catch (cause) {
        if (isDatabaseWriteConflict(cause)) return { kind: "held" };
        throw cause;
      }
      if (claim.data.status === "abandoned") return { kind: "done" };
      return {
        kind: "claimed",
        async release(outcome) {
          const settled = decodeDelivery(
            withCanonicalRecordKeys({
              ...claim,
              data: {
                ...claim.data,
                ...(outcome === "sent" ? { sentAt: now().toISOString() } : {}),
                status: outcome,
                version: claim.data.version + 1,
              },
            }),
          );
          await database.transactWrite([{ kind: "put", previousRecord: claim, record: settled }]);
        },
      };
    },
  };
}
