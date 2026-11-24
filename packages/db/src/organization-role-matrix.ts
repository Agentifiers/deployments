import type { OrganizationRole } from "./tenancy-contracts.ts";

/** Organization roles from most to least privileged; error messages list allowed roles in this order. */
export const ORGANIZATION_ROLES = [
  "owner",
  "admin",
  "billing",
  "member",
  "viewer",
] as const satisfies readonly OrganizationRole[];

/**
 * What an active organization member may do, by role. Every organization-role check in the
 * platform evaluates this table; platform administrators bypass it where the enforcement point
 * documents that bypass.
 */
export const ORGANIZATION_ROLE_MATRIX = {
  /** Read organization-scoped resources and list organization members. */
  "organization.read": ["owner", "admin", "billing", "member", "viewer"],
  /** Rename or re-slug the organization. */
  "organization.update": ["owner"],
  /**
   * Mutate organization resources: projects, environments, workspaces, service accounts, API
   * keys, agents, workflows, agent-built apps, managed-skill installations, memory, provider
   * connections, tool policies, MCP servers and connections, extensions, hosted code, model
   * policies, governance retention policy, data exports, and audit exports, and the egress
   * allowlist.
   */
  "resources.mutate": ["owner", "admin"],
  /** Add, re-role, and remove non-owner members. */
  "members.manage": ["owner", "admin"],
  /** List, create, and revoke non-owner invitations. */
  "invitations.manage": ["owner", "admin"],
  /** Grant, change, or remove the owner role, including owner invitations. */
  "owners.manage": ["owner"],
  /** Keep `email:admin`/`agent-email:admin` capabilities after admission. */
  "email.administer": ["owner", "admin"],
  /** Read any Brain erasure receipt in the organization, not only one's own. */
  "brains.erasure-receipts.read-any": ["owner", "admin"],
  /** Receive Brain grants that target an organization role. */
  "brains.role-grants.hold": ["owner", "admin", "member"],
  /** Create, change, pause, and archive spend budgets at every scope level. */
  "budgets.manage": ["owner", "admin", "billing"],
  /** Request tenant erasure of the whole organization. */
  "governance.erase": ["owner"],
  "conversations.erase": ["owner", "admin"],
  "identity.administer": ["owner", "admin"],
  "identity.enforce": ["owner"],
  /** List, inspect, set, replace, and remove the organization's own model provider keys. */
  "model-credentials.manage": ["owner", "admin"],
  /** Create, change, mute, test, and archive alert monitors. */
  "monitors.manage": ["owner", "admin"],
  /** Global platform administration (managed-skill catalog); no organization role confers it. */
  "platform.administer": [],
} as const satisfies Record<string, readonly OrganizationRole[]>;

export type OrganizationRoleAction = keyof typeof ORGANIZATION_ROLE_MATRIX;

export type BrainGrantOrganizationRole =
  (typeof ORGANIZATION_ROLE_MATRIX)["brains.role-grants.hold"][number];

export function organizationRoleAllows(
  role: OrganizationRole | undefined,
  action: OrganizationRoleAction,
): boolean {
  return (
    role !== undefined && (ORGANIZATION_ROLE_MATRIX[action] as readonly string[]).includes(role)
  );
}

export function organizationRolesAllowing(
  action: OrganizationRoleAction,
): readonly OrganizationRole[] {
  return ORGANIZATION_ROLE_MATRIX[action];
}

export function canHoldBrainRoleGrant(
  role: OrganizationRole | undefined,
): role is BrainGrantOrganizationRole {
  return organizationRoleAllows(role, "brains.role-grants.hold");
}

export const OPERATION_ROLE_ACTIONS: Readonly<Record<string, OrganizationRoleAction>> = {
  addLoginDomain: "identity.administer",
  createDirectoryToken: "identity.administer",
  createTenantErasure: "governance.erase",
  deleteIdentityProvider: "identity.administer",
  deleteIdentityProviderLink: "identity.administer",
  deleteModelCredential: "model-credentials.manage",
  getDirectory: "identity.administer",
  getIdentityProvider: "identity.administer",
  getModelCredential: "model-credentials.manage",
  listIdentityProviderLinks: "identity.administer",
  listLoginDomains: "identity.administer",
  listModelCredentials: "model-credentials.manage",
  putDirectory: "identity.administer",
  putIdentityProvider: "identity.administer",
  putModelCredential: "model-credentials.manage",
  replaceOrganizationEgressAllowlist: "resources.mutate",
  removeLoginDomain: "identity.administer",
  revokeDirectoryToken: "identity.administer",
  setIdentityProviderState: "identity.administer",
  verifyLoginDomain: "identity.administer",
};

export function operationRoleAction(operation: string): OrganizationRoleAction | undefined {
  return Object.hasOwn(OPERATION_ROLE_ACTIONS, operation)
    ? OPERATION_ROLE_ACTIONS[operation]
    : undefined;
}

interface CapabilityRule {
  /** Every level the namespace defines; a denied `<namespace>:*` expands to the permitted ones. */
  readonly levels: readonly string[];
  /** Levels whose use requires a role action; unlisted levels are role-independent. */
  readonly restricted: Readonly<Record<string, OrganizationRoleAction>>;
  /** Removed from the identity's scopes when a human request is admitted. */
  readonly appliedAtAdmission?: true;
}

/**
 * Role restrictions per capability namespace. Namespaces that are absent (evaluations,
 * observability, Brains, ...) are governed by token scopes and their own resource grants only.
 * Runtime namespaces mirror the runtime API, which requires `resources.mutate` from human callers
 * of every route whose required scope is not `<namespace>:read`.
 */
export const ORGANIZATION_CAPABILITY_RULES: Readonly<Record<string, CapabilityRule>> = {
  "agent-email": {
    appliedAtAdmission: true,
    levels: ["read", "write", "admin"],
    restricted: { admin: "email.administer" },
  },
  agents: { levels: ["read", "write"], restricted: { write: "resources.mutate" } },
  "api-keys": { levels: ["read", "write"], restricted: { write: "resources.mutate" } },
  apps: {
    levels: ["read", "write", "publish"],
    restricted: { publish: "resources.mutate", write: "resources.mutate" },
  },
  approvals: { levels: ["read", "write"], restricted: { write: "resources.mutate" } },
  artifacts: { levels: ["read", "write"], restricted: { write: "resources.mutate" } },
  budgets: { levels: ["read", "write"], restricted: { write: "budgets.manage" } },
  channels: { levels: ["read", "write"], restricted: { write: "resources.mutate" } },
  "end-users": { levels: ["erase"], restricted: { erase: "conversations.erase" } },
  email: {
    appliedAtAdmission: true,
    levels: ["read", "write", "admin"],
    restricted: { admin: "email.administer" },
  },
  environments: { levels: ["read", "write"], restricted: { write: "resources.mutate" } },
  governance: { levels: ["read", "write"], restricted: { write: "resources.mutate" } },
  invitations: {
    levels: ["read", "write", "accept"],
    restricted: { read: "invitations.manage", write: "invitations.manage" },
  },
  "managed-skills": {
    levels: ["read", "install", "admin"],
    restricted: { admin: "platform.administer", install: "resources.mutate" },
  },
  members: { levels: ["read", "write"], restricted: { write: "members.manage" } },
  memory: {
    levels: ["read", "write", "execute", "admin"],
    restricted: {
      admin: "resources.mutate",
      execute: "resources.mutate",
      write: "resources.mutate",
    },
  },
  models: { levels: ["read", "write"], restricted: { write: "resources.mutate" } },
  monitors: { levels: ["read", "write"], restricted: { write: "monitors.manage" } },
  organizations: { levels: ["read", "write"], restricted: { write: "organization.update" } },
  projects: { levels: ["read", "write"], restricted: { write: "resources.mutate" } },
  providers: { levels: ["read", "write"], restricted: { write: "resources.mutate" } },
  runs: {
    levels: ["read", "write", "erase"],
    restricted: { erase: "conversations.erase", write: "resources.mutate" },
  },
  schedules: { levels: ["read", "write"], restricted: { write: "resources.mutate" } },
  "service-accounts": { levels: ["read", "write"], restricted: { write: "resources.mutate" } },
  tools: { levels: ["read", "write"], restricted: { write: "resources.mutate" } },
  webhooks: { levels: ["read", "write"], restricted: { write: "resources.mutate" } },
  workflows: {
    levels: ["read", "write", "execute"],
    restricted: { execute: "resources.mutate", write: "resources.mutate" },
  },
  workspaces: { levels: ["read", "write"], restricted: { write: "resources.mutate" } },
};

function adjustScopes(
  role: OrganizationRole,
  scopes: readonly string[],
  applies: (rule: CapabilityRule) => boolean,
) {
  const adjusted: string[] = [];
  for (const scope of scopes) {
    const separator = scope.indexOf(":");
    const rule =
      separator > 0 ? ORGANIZATION_CAPABILITY_RULES[scope.slice(0, separator)] : undefined;
    if (!rule || !applies(rule)) {
      adjusted.push(scope);
      continue;
    }
    const namespace = scope.slice(0, separator);
    const level = scope.slice(separator + 1);
    const permitted = (candidate: string) => {
      const action = rule.restricted[candidate];
      return action === undefined || organizationRoleAllows(role, action);
    };
    if (level !== "*") {
      if (permitted(level)) adjusted.push(scope);
    } else if (rule.levels.every(permitted)) {
      adjusted.push(scope);
    } else {
      adjusted.push(...rule.levels.filter(permitted).map((allowed) => `${namespace}:${allowed}`));
    }
  }
  return [...new Set(adjusted)];
}

/**
 * Scopes a human token keeps once its organization membership is verified. Only namespaces
 * marked `appliedAtAdmission` are narrowed here; the rest are enforced per operation.
 */
export function admittedOrganizationScopes(
  role: OrganizationRole,
  scopes: readonly string[],
): readonly string[] {
  return adjustScopes(role, scopes, (rule) => rule.appliedAtAdmission === true);
}

/**
 * Capabilities a member can actually exercise in the organization: token scopes intersected
 * with every role restriction in the matrix.
 */
export function effectiveOrganizationCapabilities(
  role: OrganizationRole,
  scopes: readonly string[],
): readonly string[] {
  return adjustScopes(role, scopes, () => true);
}
