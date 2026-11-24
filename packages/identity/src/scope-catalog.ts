import type { SUPPORTED_OAUTH_SCOPES } from "./tokens.ts";

export type SupportedOAuthScope = (typeof SUPPORTED_OAUTH_SCOPES)[number];

/** Display order of the areas a consent screen groups scopes under. */
export const SCOPE_AREAS = [
  "Your account",
  "Organizations and projects",
  "Agents and automation",
  "Knowledge and memory",
  "Connections and messages",
  "Models, usage, and monitoring",
  "Keys and secrets",
  "Data and governance",
] as const;

export type ScopeArea = (typeof SCOPE_AREAS)[number];

interface ScopeMeaning {
  readonly action: string;
  readonly area: ScopeArea;
  readonly subject: string;
}

const meaning = (area: ScopeArea, subject: string, action: string): ScopeMeaning => ({
  action,
  area,
  subject,
});

const CHANGE = "create and change";

/**
 * What each OAuth scope lets a client do, in the words a person approving it reads. Typed over
 * every supported scope, so a new scope does not compile until it says what it grants.
 */
export const SCOPE_CATALOG = {
  "agent-email:admin": meaning("Connections and messages", "Agent email", "administer"),
  "agent-email:read": meaning("Connections and messages", "Agent email", "view"),
  "agent-email:write": meaning("Connections and messages", "Agent email", "draft and send"),
  "agents:read": meaning("Agents and automation", "Agents", "view"),
  "agents:write": meaning("Agents and automation", "Agents", CHANGE),
  "api-keys:read": meaning("Keys and secrets", "API keys", "view"),
  "api-keys:write": meaning("Keys and secrets", "API keys", "create and revoke"),
  "approvals:read": meaning("Agents and automation", "Approvals", "view"),
  "approvals:write": meaning("Agents and automation", "Approvals", "resolve"),
  "apps:publish": meaning("Agents and automation", "Apps", "publish"),
  "apps:read": meaning("Agents and automation", "Apps", "view"),
  "apps:write": meaning("Agents and automation", "Apps", CHANGE),
  "artifacts:read": meaning("Agents and automation", "Artifacts", "view"),
  "artifacts:write": meaning("Agents and automation", "Artifacts", "upload and change"),
  "audit:read": meaning("Data and governance", "Audit log", "view"),
  "brains:admin": meaning("Knowledge and memory", "Brains", "administer"),
  "brains:create": meaning("Knowledge and memory", "Brains", "create"),
  "brains:read": meaning("Knowledge and memory", "Brains", "view"),
  "brains:write": meaning("Knowledge and memory", "Brains", "change"),
  "budgets:read": meaning("Models, usage, and monitoring", "Budgets", "view"),
  "budgets:write": meaning("Models, usage, and monitoring", "Budgets", CHANGE),
  "channels:read": meaning("Connections and messages", "Channel bindings", "view"),
  email: meaning("Your account", "Your email address", "view"),
  "email:admin": meaning("Connections and messages", "Email sending", "administer"),
  "email:read": meaning("Connections and messages", "Email sending", "view"),
  "email:write": meaning("Connections and messages", "Email sending", "send"),
  "end-users:erase": meaning("Data and governance", "End-user data", "erase"),
  "environments:read": meaning("Organizations and projects", "Environments", "view"),
  "environments:write": meaning("Organizations and projects", "Environments", CHANGE),
  "governance:read": meaning("Data and governance", "Retention, exports, and erasure", "view"),
  "governance:write": meaning("Data and governance", "Retention, exports, and erasure", "start"),
  "invitations:accept": meaning("Your account", "Invitations sent to you", "accept"),
  "invitations:read": meaning("Organizations and projects", "Invitations", "view"),
  "invitations:write": meaning("Organizations and projects", "Invitations", "send and revoke"),
  "managed-skills:admin": meaning("Agents and automation", "Managed skills", "administer"),
  "managed-skills:install": meaning("Agents and automation", "Managed skills", "install"),
  "managed-skills:read": meaning("Agents and automation", "Managed skills", "view"),
  "members:read": meaning("Organizations and projects", "Members", "view"),
  "members:write": meaning("Organizations and projects", "Members", "add, change, and remove"),
  "memory:admin": meaning("Knowledge and memory", "Memory", "administer"),
  "memory:execute": meaning("Knowledge and memory", "Memory", "use during runs"),
  "memory:read": meaning("Knowledge and memory", "Memory", "view"),
  "memory:write": meaning("Knowledge and memory", "Memory", "change"),
  "models:read": meaning("Models, usage, and monitoring", "Models and model keys", "view"),
  "models:write": meaning("Models, usage, and monitoring", "Models and model keys", CHANGE),
  "monitors:read": meaning("Models, usage, and monitoring", "Monitors and alerts", "view"),
  "monitors:write": meaning("Models, usage, and monitoring", "Monitors and alerts", CHANGE),
  "observability:read": meaning("Models, usage, and monitoring", "Traces and evaluations", "view"),
  "observability:write": meaning("Models, usage, and monitoring", "Traces and evaluations", "add"),
  offline_access: meaning("Your account", "Your sign-in", "keep active until you sign out"),
  openid: meaning("Your account", "Your identity", "confirm"),
  "organizations:read": meaning("Organizations and projects", "Organizations", "view"),
  "organizations:write": meaning("Organizations and projects", "Organizations", CHANGE),
  profile: meaning("Your account", "Your name", "view"),
  "projects:read": meaning("Organizations and projects", "Projects", "view"),
  "projects:write": meaning("Organizations and projects", "Projects", CHANGE),
  "providers:read": meaning("Connections and messages", "Connections to other services", "view"),
  "providers:write": meaning("Connections and messages", "Connections to other services", CHANGE),
  "runs:erase": meaning("Data and governance", "Threads", "erase"),
  "runs:read": meaning("Agents and automation", "Runs and threads", "view"),
  "runs:write": meaning("Agents and automation", "Runs and threads", "start and change"),
  "schedules:read": meaning("Agents and automation", "Schedules and heartbeats", "view"),
  "schedules:write": meaning("Agents and automation", "Schedules and heartbeats", CHANGE),
  "secrets:read": meaning("Keys and secrets", "Secret references", "view"),
  "service-accounts:read": meaning("Keys and secrets", "Service accounts", "view"),
  "service-accounts:write": meaning("Keys and secrets", "Service accounts", CHANGE),
  "spend:read": meaning("Models, usage, and monitoring", "Spend", "view"),
  "tools:read": meaning("Agents and automation", "Tools", "view"),
  "tools:write": meaning("Agents and automation", "Tools", CHANGE),
  "usage:read": meaning("Models, usage, and monitoring", "Usage", "view"),
  "webhooks:read": meaning("Connections and messages", "Webhooks", "view"),
  "webhooks:write": meaning("Connections and messages", "Webhooks", CHANGE),
  "workflows:execute": meaning("Agents and automation", "Workflows", "start and cancel"),
  "workflows:read": meaning("Agents and automation", "Workflows", "view"),
  "workflows:write": meaning("Agents and automation", "Workflows", CHANGE),
  "workspaces:read": meaning("Organizations and projects", "Workspaces", "view"),
  "workspaces:write": meaning("Organizations and projects", "Workspaces", CHANGE),
} as const satisfies Readonly<Record<SupportedOAuthScope, ScopeMeaning>>;

/** One subject inside an area, with every action the requested scopes allow on it. */
export interface ScopeSubject {
  readonly actions: readonly string[];
  readonly subject: string;
}

/** An area of the product and what the requested scopes allow in it. */
export interface ScopeGroup {
  /** One of `SCOPE_AREAS`, or `Other access` for a scope the catalog does not know. */
  readonly area: string;
  readonly subjects: readonly ScopeSubject[];
}

const OTHER_AREA = "Other access";

/**
 * Groups requested scopes into plain-language areas, in `SCOPE_AREAS` order with subjects in
 * catalog order. A scope the catalog does not know is listed by its raw name under `Other access`,
 * so a consent screen never hides what it grants.
 */
export function describeScopes(scopes: readonly string[]): readonly ScopeGroup[] {
  const requested = new Set(scopes);
  const groups = new Map<string, Map<string, string[]>>();
  const add = (area: string, subject: string, action: string) => {
    const subjects = groups.get(area) ?? new Map<string, string[]>();
    subjects.set(subject, [...(subjects.get(subject) ?? []), action]);
    groups.set(area, subjects);
  };
  for (const area of SCOPE_AREAS) {
    for (const [scope, entry] of Object.entries(SCOPE_CATALOG)) {
      if (entry.area === area && requested.has(scope)) add(area, entry.subject, entry.action);
    }
  }
  for (const scope of requested) {
    if (!Object.hasOwn(SCOPE_CATALOG, scope)) add(OTHER_AREA, scope, "allowed");
  }
  return [...groups].map(([area, subjects]) => ({
    area,
    subjects: [...subjects].map(([subject, actions]) => ({ actions, subject })),
  }));
}
