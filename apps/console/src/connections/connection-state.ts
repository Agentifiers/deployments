import type { AgentDeploymentResponse } from "@deployments-ai/api-contract/agents";
import type {
  ConnectionCapabilityResponse,
  ConnectionGrantResponse,
  ConnectionVerificationResponse,
  ProviderApplicationRegistrationRequest,
  ProviderConnectionResponse,
} from "@deployments-ai/api-contract/providers";
import type { JsonValue } from "@deployments-ai/api-contract/primitives";
import type { WorkspaceResponse } from "@deployments-ai/api-contract/tenancy";
import type { OperationAccess } from "../access.ts";
import { attributeGrants } from "../components/agents/runtime/access-attribution.ts";
import { oneOf } from "../observability/range.ts";
import { CONNECTION_PROBLEM_STATUSES } from "../overview/status-counts.ts";
import type { CredentialFieldView } from "./credential-form.ts";

export type ConnectionView = typeof ProviderConnectionResponse.Type;
export type CapabilityView = typeof ConnectionCapabilityResponse.Type;
export type GrantView = typeof ConnectionGrantResponse.Type;
export type VerificationView = typeof ConnectionVerificationResponse.Type;
export type WorkspaceView = typeof WorkspaceResponse.Type;

/** A deployment as the connection pages read it: its pins and whether it can be updated. */
export type PinningDeploymentView = Pick<
  AgentDeploymentResponse,
  "agentDefinitionId" | "currentState" | "desiredState" | "id" | "runtimeConfig" | "version"
>;

export const CONNECTION_STATUSES = [
  "active",
  "reauthorization-required",
  "error",
  "disconnected",
] as const;

/** `current` hides disconnected connections; `attention` is what the overview block counts. */
export const CONNECTION_FILTERS = ["current", "attention", ...CONNECTION_STATUSES, "all"] as const;
export type ConnectionFilter = (typeof CONNECTION_FILTERS)[number];

export type ConnectionAction = "verify" | "rotate" | "grant" | "reauthorize" | "revoke";

export interface ConnectionSearch {
  readonly status?: ConnectionFilter;
}

export interface ConnectionPage {
  readonly items: readonly ConnectionView[];
  readonly nextOffset?: number;
  /** False when the environment has more connections than the console reads. */
  readonly complete: boolean;
}

export type TokenEndpointAuthMethod = NonNullable<
  (typeof ProviderApplicationRegistrationRequest.Type)["tokenEndpointAuthMethod"]
>;

/** How OAuth apps for one provider are registered, and whether connecting it needs one. */
export interface ProviderOAuthEntry {
  /** Last segment of the platform's callback path: the definition's OAuth provider key. */
  readonly callbackKey: string;
  /** Scopes an app may request. */
  readonly appScopes: readonly string[];
  /** Vendor MCP only: how a pre-registered client authenticates at the token endpoint. */
  readonly tokenEndpointAuthMethods?: readonly TokenEndpointAuthMethod[];
  /** Platform OAuth always needs an app; a vendor only when it accepts no other client. */
  readonly requiresApp: boolean;
}

interface CatalogEntryBase {
  readonly key: string;
  readonly displayName: string;
  readonly route: string;
  readonly fields: readonly CredentialFieldView[];
  /** The tenant URL a templated vendor MCP server needs, sent as `requestedResource`. */
  readonly resource?: { readonly label: string; readonly template: string };
  /** Whether a verification can run, which is the only way to a grantable capability. */
  readonly verifiable: boolean;
}

/** One way to connect a provider, read from the provider registry on the console server. */
export type ProviderCatalogEntry =
  | (CatalogEntryBase & { readonly access: "credential" | "credentialless" })
  | (CatalogEntryBase & { readonly access: "oauth"; readonly oauth: ProviderOAuthEntry });

export interface GrantUse {
  readonly deploymentId: string;
  readonly toolName: string;
}

export interface GrantRow {
  readonly grant: GrantView;
  readonly uses: readonly GrantUse[];
}

const FILTER_MATCHES: Readonly<Record<ConnectionFilter, (status: string) => boolean>> = {
  active: (status) => status === "active",
  all: () => true,
  attention: (status) => oneOf(CONNECTION_PROBLEM_STATUSES, status) !== undefined,
  current: (status) => status !== "disconnected",
  disconnected: (status) => status === "disconnected",
  error: (status) => status === "error",
  "reauthorization-required": (status) => status === "reauthorization-required",
};

export function parseConnectionSearch(search: Readonly<Record<string, unknown>>): ConnectionSearch {
  const status = oneOf(CONNECTION_FILTERS, search.status);
  return status === undefined || status === "current" ? {} : { status };
}

/**
 * One offset page of the connections that match `filter`, most recently updated first. Pages of
 * the API list can repeat a connection that changed status mid-walk, so the latest copy wins.
 */
export function connectionPage(
  all: readonly ConnectionView[],
  {
    complete,
    filter,
    offset,
    pageSize,
  }: {
    readonly complete: boolean;
    readonly filter: ConnectionFilter;
    readonly offset: number;
    readonly pageSize: number;
  },
): ConnectionPage {
  const latest = new Map<string, ConnectionView>();
  for (const connection of all) {
    const seen = latest.get(connection.id);
    if (!seen || seen.version < connection.version) latest.set(connection.id, connection);
  }
  const matches = [...latest.values()]
    .filter((connection) => FILTER_MATCHES[filter](connection.status))
    .toSorted(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    );
  const end = offset + pageSize;
  return {
    complete,
    items: matches.slice(offset, end),
    ...(end < matches.length ? { nextOffset: end } : {}),
  };
}

type ActionOperation = keyof Pick<
  OperationAccess,
  | "beginProviderAuthorization"
  | "createConnectionGrant"
  | "requestConnectionVerification"
  | "revokeProviderConnection"
  | "rotateProviderCredential"
>;

const ACTION_RULES: readonly (readonly [
  ConnectionAction,
  ActionOperation,
  (connection: ConnectionView) => boolean,
])[] = [
  [
    "verify",
    "requestConnectionVerification",
    (connection) =>
      connection.hasCredential &&
      (connection.status === "active" ||
        (connection.status === "reauthorization-required" && connection.authMethod !== "oauth")),
  ],
  [
    "rotate",
    "rotateProviderCredential",
    (connection) =>
      connection.status !== "disconnected" &&
      connection.authMethod === "static" &&
      connection.hasCredential,
  ],
  ["grant", "createConnectionGrant", (connection) => connection.status === "active"],
  ["reauthorize", "beginProviderAuthorization", (connection) => connection.authMethod === "oauth"],
  ["revoke", "revokeProviderConnection", (connection) => connection.status !== "disconnected"],
];

/**
 * What the caller may do with the connection now. A disconnected connection is final, except
 * that an OAuth one can be reauthorized to move its grants and pins to a new connection.
 */
export function connectionActions(
  connection: ConnectionView,
  access: Pick<OperationAccess, ActionOperation>,
): readonly ConnectionAction[] {
  return ACTION_RULES.filter(
    ([, operation, applies]) => access[operation] && applies(connection),
  ).map(([action]) => action);
}

/**
 * What the connection's page offers when live deployments pin its revoked grants. A restore
 * recreates the grants on the connection itself, which needs a connection that can verify; an
 * OAuth connection that is not active needs a new authorization instead.
 */
export function deniedToolsRemedy(
  connection: Pick<ConnectionView, "authMethod" | "status">,
): "reauthorize" | "restore" | undefined {
  if (connection.authMethod === "oauth" && connection.status !== "active") return "reauthorize";
  return connection.status === "disconnected" ? undefined : "restore";
}

/**
 * Scopes a new grant may ask for: the active capabilities' scopes the connection still holds,
 * sorted. `undefined` until a verification records an active capability, because the API
 * refuses grants on an unverified connection.
 */
export function grantableScopes(
  connection: Pick<ConnectionView, "scopes">,
  capabilities: readonly CapabilityView[],
): readonly string[] | undefined {
  const active = capabilities.filter((capability) => capability.status === "active");
  if (active.length === 0) return undefined;
  const held = new Set(connection.scopes);
  return [...new Set(active.flatMap((capability) => capability.scopes))]
    .filter((scope) => held.has(scope))
    .toSorted();
}

/** Stopped deployments cannot run or be updated, so their pins do not count. */
export function isLiveDeployment(deployment: Pick<PinningDeploymentView, "desiredState">) {
  return deployment.desiredState !== "stopped";
}

/** The connection's grants, active first and newest first, with the live tools pinning each. */
export function grantRows(
  connectionId: string,
  grants: readonly GrantView[],
  deployments: readonly PinningDeploymentView[],
): readonly GrantRow[] {
  const uses = new Map(
    attributeGrants(deployments.filter(isLiveDeployment), grants).map(
      ({ grantId, uses: grantUses }) => [
        grantId,
        grantUses.map(({ deploymentId, toolName }) => ({ deploymentId, toolName })),
      ],
    ),
  );
  return grants
    .filter((grant) => grant.connectionId === connectionId)
    .toSorted(
      (left, right) =>
        Number(left.status !== "active") - Number(right.status !== "active") ||
        right.createdAt.localeCompare(left.createdAt),
    )
    .map((grant) => ({ grant, uses: uses.get(grant.id) ?? [] }));
}

/** The connection's grants in one status and the live deployments that pin any of them. */
export interface GrantImpact {
  readonly grants: number;
  readonly deployments: number;
}

/**
 * For `active`: what a rotate or revoke breaks. For `revoked`: the deployments whose tools the
 * runtime denies until a rebind re-pins them.
 */
export function grantImpact(
  connectionId: string,
  grants: readonly GrantView[],
  deployments: readonly PinningDeploymentView[],
  status: GrantView["status"],
): GrantImpact {
  const rows = grantRows(connectionId, grants, deployments).filter(
    (row) => row.grant.status === status,
  );
  return {
    deployments: new Set(rows.flatMap((row) => row.uses.map((use) => use.deploymentId))).size,
    grants: rows.length,
  };
}

export type ParsedConstraints =
  | { readonly ok: true; readonly value?: { readonly [key: string]: JsonValue } }
  | { readonly ok: false; readonly message: string };

/**
 * A grant's optional `externalResourceConstraints`: a JSON object whose fields the runtime
 * forces into every tool call the grant authorizes. Blank means none.
 */
export function parseGrantConstraints(text: string): ParsedConstraints {
  if (text.trim() === "") return { ok: true };
  let value: JsonValue;
  try {
    value = JSON.parse(text);
  } catch {
    return { message: "Constraints must be valid JSON.", ok: false };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { message: "Constraints must be a JSON object.", ok: false };
  }
  return Object.keys(value).length === 0
    ? { ok: true }
    : { ok: true, value: Object.fromEntries(Object.entries(value)) };
}

export interface VerificationOutcome {
  readonly method?: string;
  readonly scopes: readonly string[];
  readonly problem?: string;
}

/** The readable parts of a verification's untyped `result` and `error` metadata. */
export function verificationOutcome(verification: VerificationView): VerificationOutcome {
  const { error, result } = verification;
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);
  const method = text(result?.method);
  const problem = text(error?.message) ?? text(error?.code);
  return {
    scopes: Array.isArray(result?.scopes)
      ? result.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    ...(method ? { method } : {}),
    ...(problem ? { problem } : {}),
  };
}
