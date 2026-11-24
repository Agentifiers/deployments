import {
  MONITOR_KINDS,
  SemanticEventData,
  type AlertDeliveryPersistence,
  type AlertRecipient,
  type MonitorPersistence,
  type Ulid,
} from "@deployments-ai/db";
import { renderAlertEmail, type AlertEmailStatus } from "@deployments-ai/identity-emails";
import { Schema } from "effect";

/** What one alert email needs from the install that sends it. */
export interface AlertEmailInstall {
  /** Console origin the email links into, with no trailing slash. */
  readonly consoleOrigin: string;
  /** Name shown in the email header: the install's product name. */
  readonly productName: string;
}

export interface AlertEmailDependencies {
  readonly delivery: AlertDeliveryPersistence;
  readonly install: AlertEmailInstall;
  readonly monitors: MonitorPersistence;
  readonly send: (email: {
    readonly html: string;
    readonly preferencesUrl: string;
    readonly recipient: string;
    readonly subject: string;
    readonly text: string;
  }) => Promise<void>;
}

const STATUS_BY_EVENT: Readonly<Record<string, AlertEmailStatus>> = {
  "alert.fired": "fired",
  "alert.renotified": "renotified",
  "alert.resolved": "resolved",
  "alert.test": "test",
};

/** Alert events whose email this worker sends. */
export const ALERT_EMAIL_EVENT_TYPES = Object.keys(STATUS_BY_EVENT);

const AlertPayload = Schema.Struct({
  deliverEmail: Schema.Boolean,
  emailPrincipalId: Schema.optional(Schema.String),
  incidentId: Schema.optional(Schema.String),
  monitorId: Schema.String,
  monitorName: Schema.String,
  openedAt: Schema.String,
  summary: Schema.String,
});
const decodeEvent = Schema.decodeUnknownSync(SemanticEventData);
const decodePayload = Schema.decodeUnknownSync(AlertPayload);

function links(
  install: AlertEmailInstall,
  organizationId: string,
  payload: typeof AlertPayload.Type,
) {
  const alerts = `${install.consoleOrigin}/o/${organizationId}/alerts`;
  return {
    actionUrl: payload.incidentId
      ? `${alerts}/incidents/${payload.monitorId}/${payload.incidentId}`
      : `${alerts}/monitors/${payload.monitorId}`,
    preferencesUrl: `${alerts}/settings`,
  };
}

/**
 * Emails one alert event to its recipients. Each member's email is claimed before it is sent, so
 * a redelivered event emails nobody twice. A send that fails releases its claim, and a claim
 * another sender holds may still die unsent, so both rethrow and the event is retried for the
 * members still owed an email.
 */
export async function sendAlertEmails(
  input: { readonly detail: unknown; readonly source?: string },
  dependencies: AlertEmailDependencies,
) {
  if (input.source !== undefined && input.source !== "deployments-ai.platform") return;
  const event = decodeEvent(input.detail);
  const status = STATUS_BY_EVENT[event.eventType];
  if (!status) return;
  const payload = decodePayload(event.payload);
  if (!payload.deliverEmail) return;
  const organizationId = event.organizationId as Ulid;
  const monitor = await dependencies.monitors
    .get(organizationId, payload.monitorId as Ulid)
    .catch(() => undefined);
  if (!monitor) return;
  let recipients: readonly AlertRecipient[];
  if (status === "test") {
    const member = payload.emailPrincipalId
      ? await dependencies.delivery.member(organizationId, payload.emailPrincipalId as Ulid)
      : undefined;
    recipients = member ? [member] : [];
  } else {
    recipients = await dependencies.delivery.recipients(monitor);
  }
  const { actionUrl, preferencesUrl } = links(dependencies.install, organizationId, payload);
  const rendered = await renderAlertEmail({
    actionUrl,
    monitorName: payload.monitorName,
    openedAt: payload.openedAt,
    preferencesUrl,
    productName: dependencies.install.productName,
    scopeLabel: `${MONITOR_KINDS[monitor.data.condition.kind].label} monitor for ${
      monitor.data.environmentId ? "one environment" : "the whole organization"
    }`,
    status,
    summary: payload.summary,
  });
  const failures: unknown[] = [];
  for (const recipient of recipients) {
    const claim = await dependencies.delivery.claimEmail({
      eventId: event.eventId as Ulid,
      organizationId,
      principalId: recipient.principalId,
    });
    if (claim.kind === "done") continue;
    if (claim.kind === "held") {
      failures.push(
        new Error(`Another sender holds the alert email claim for ${recipient.principalId}.`),
      );
      continue;
    }
    try {
      await dependencies.send({ ...rendered, preferencesUrl, recipient: recipient.email });
    } catch (cause) {
      failures.push(cause);
      await claim.release("failed").catch(() => undefined);
      continue;
    }
    // The email went out. Failing the event over its bookkeeping would only retry it into a
    // resend once the claim goes stale, so a failed record is logged and the event succeeds.
    await claim.release("sent").catch((cause: unknown) => {
      console.error("Alert email sent but not recorded.", {
        error: cause instanceof Error ? cause.message : "Unknown error.",
        eventId: event.eventId,
        principalId: recipient.principalId,
      });
    });
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} alert email(s) failed to send.`);
  }
}
