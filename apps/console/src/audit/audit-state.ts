const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;
const MAX_EVENT_LENGTH = 256;

export type AuditScope = "environment" | "organization";

/**
 * The API's own filters, each an exact match: `actor` against the actor ID, `resource` against
 * the resource ID, `event` against the action. `since` is inclusive and `until` exclusive, both
 * canonical `toISOString()` instants. A page cursor is sealed to these values.
 */
export interface AuditFilters {
  readonly actor?: string;
  readonly event?: string;
  readonly resource?: string;
  readonly since?: string;
  readonly until?: string;
}

export const AUDIT_FILTER_FIELDS = ["actor", "resource", "event", "since", "until"] as const;
export type AuditFilterField = (typeof AUDIT_FILTER_FIELDS)[number];

export const AUDIT_ACTIONS: Readonly<Record<AuditScope, readonly string[]>> = {
  environment: [
    "credential.read",
    "credential.create",
    "credential.rotate",
    "credential.revoke",
    "provider.oauth.authorized",
    "provider.oauth.reauthorization-required",
    "provider.tool.outcome-unknown",
    "sandbox.allocation-recovery",
    "sandbox.lease-mismatch",
  ],
  organization: [
    "organization.created",
    "organization.updated",
    "project.created",
    "project.updated",
    "project.archived",
    "environment.created",
    "environment.updated",
    "environment.archived",
    "organization-member.added",
    "organization-member.role-updated",
    "organization-member.removed",
    "organization-invitation.created",
    "organization-invitation.revoked",
    "organization-invitation.accepted",
    "retention-policy.updated",
    "tenant-export.requested",
    "audit-export.requested",
    "tenant-erasure.requested",
    "organization.operator-access-opened",
    "organization.operator-access-renewed",
    "organization.operator-access-closed",
  ],
};

/** Plain wording for actions whose code alone does not say who did what. */
export const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  "organization.operator-access-closed": "Platform administrator closed operator access",
  "organization.operator-access-opened": "Platform administrator opened operator access",
  "organization.operator-access-renewed": "Platform administrator renewed operator access",
};

export const AUDIT_SCOPE_NOTE: Readonly<Record<AuditScope, string>> = {
  environment:
    "Records credential reads and lifecycle changes, provider authorizations, uncertain tool outcomes, and sandbox recoveries. Changes to agents, deployments, policies, API keys, webhooks, and budgets are not audited here.",
  organization:
    "Records changes to the organization, its projects and environments, members and invitations, retention, governance requests, and when platform administrators open or close operator access to it. Environment events are in each environment's audit log.",
};

const isInstant = (value: unknown): value is string =>
  typeof value === "string" &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString() === value;

export function parseAuditSearch(search: Readonly<Record<string, unknown>>): AuditFilters {
  const { actor, event, resource, since, until } = search;
  const trimmedEvent = typeof event === "string" ? event.trim() : "";
  const ordered = !isInstant(since) || !isInstant(until) || since < until;
  return {
    ...(typeof actor === "string" && ULID.test(actor) ? { actor } : {}),
    ...(trimmedEvent.length > 0 && trimmedEvent.length <= MAX_EVENT_LENGTH
      ? { event: trimmedEvent }
      : {}),
    ...(typeof resource === "string" && ULID.test(resource) ? { resource } : {}),
    ...(isInstant(since) ? { since } : {}),
    ...(isInstant(until) && ordered ? { until } : {}),
  };
}

export type AuditFilterDraft = Readonly<Record<AuditFilterField, string>>;

export type AuditDraftResult =
  | { readonly kind: "valid"; readonly filters: AuditFilters }
  | {
      readonly kind: "invalid";
      readonly issues: Readonly<Partial<Record<AuditFilterField, string>>>;
    };

function localInstant(value: string): string | undefined {
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? undefined : new Date(milliseconds).toISOString();
}

export function readAuditDraft(draft: AuditFilterDraft): AuditDraftResult {
  const actor = draft.actor.trim();
  const resource = draft.resource.trim();
  const event = draft.event.trim();
  const since = draft.since === "" ? undefined : localInstant(draft.since);
  const until = draft.until === "" ? undefined : localInstant(draft.until);
  const issues: Partial<Record<AuditFilterField, string>> = {};
  if (actor !== "" && !ULID.test(actor))
    issues.actor = "Enter a principal, agent, or service account ID.";
  if (resource !== "" && !ULID.test(resource)) issues.resource = "Enter a resource ID.";
  if (event.length > MAX_EVENT_LENGTH)
    issues.event = `Enter at most ${MAX_EVENT_LENGTH} characters.`;
  if (draft.since !== "" && since === undefined) issues.since = "Enter a date and time.";
  if (draft.until !== "" && until === undefined) issues.until = "Enter a date and time.";
  if (since !== undefined && until !== undefined && since >= until)
    issues.until = "Choose a time after the start.";
  if (Object.keys(issues).length > 0) return { issues, kind: "invalid" };
  return {
    filters: {
      ...(actor === "" ? {} : { actor }),
      ...(event === "" ? {} : { event }),
      ...(resource === "" ? {} : { resource }),
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
    },
    kind: "valid",
  };
}

function datetimeLocalValue(instant: string): string {
  const date = new Date(instant);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function auditDraft(filters: AuditFilters): AuditFilterDraft {
  return {
    actor: filters.actor ?? "",
    event: filters.event ?? "",
    resource: filters.resource ?? "",
    since: filters.since === undefined ? "" : datetimeLocalValue(filters.since),
    until: filters.until === undefined ? "" : datetimeLocalValue(filters.until),
  };
}

export const isFiltered = (filters: AuditFilters) => Object.keys(filters).length > 0;

export function changeEntries(
  changes: Readonly<Record<string, unknown>> | undefined,
): readonly (readonly [string, string])[] {
  return Object.entries(changes ?? {}).map(([key, value]) => [
    key,
    typeof value === "string" ? value : JSON.stringify(value),
  ]);
}
