import { PUBLIC_ID_PATTERN, resolveSlug } from "@deployments-ai/api-contract/primitives";
import { TENANCY_PATHS, type ApiContextScope } from "@deployments-ai/api-contract/routes";
import { handleAgentMockRoutes } from "./agent-mock-routes.ts";
import { handleAgentReleaseLifecycleMockRoutes } from "./agent-release-lifecycle-mock-routes.ts";
import type { PlatformRequest } from "./index.ts";
import { handleTenancyResourceMockRoutes } from "./tenancy-resource-mock-routes.ts";
import { handleWorkflowSkillMockRoutes } from "./workflow-skill-mock-routes.ts";

export const tenancyMockRouteHandlers = [
  handleWorkflowSkillMockRoutes,
  handleAgentMockRoutes,
  handleAgentReleaseLifecycleMockRoutes,
  handleTenancyResourceMockRoutes,
] as const;

export const MOCK_TENANCY_FIXTURE_IDS = Object.freeze({
  agentDefinition: "01ARZ3NDEKTSV4RRFFQ69G5FB5",
  agentDeployment: "01ARZ3NDEKTSV4RRFFQ69G5FB6",
  agentRelease: "01ARZ3NDEKTSV4RRFFQ69G5FB7",
  apiCredential: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  environment: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
  invitation: "01ARZ3NDEKTSV4RRFFQ69G5FB8",
  member: "01ARZ3NDEKTSV4RRFFQ69G5FB9",
  organization: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  project: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
  serviceAccount: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  workspace: "01ARZ3NDEKTSV4RRFFQ69G5FBA",
});

export const MOCK_TENANCY_CONTEXT = Object.freeze({
  environmentId: MOCK_TENANCY_FIXTURE_IDS.environment,
  organizationId: MOCK_TENANCY_FIXTURE_IDS.organization,
  projectId: MOCK_TENANCY_FIXTURE_IDS.project,
});

export const ORGANIZATION_IDS = [
  MOCK_TENANCY_FIXTURE_IDS.organization,
  "01ARZ3NDEKTSV4RRFFQ69G5FB0",
] as const;
export const PROJECT_IDS = [
  MOCK_TENANCY_FIXTURE_IDS.project,
  "01ARZ3NDEKTSV4RRFFQ69G5FB1",
] as const;
export const ENVIRONMENT_IDS = [
  MOCK_TENANCY_FIXTURE_IDS.environment,
  "01ARZ3NDEKTSV4RRFFQ69G5FB2",
] as const;
export const SERVICE_ACCOUNT_IDS = [
  MOCK_TENANCY_FIXTURE_IDS.serviceAccount,
  "01ARZ3NDEKTSV4RRFFQ69G5FB3",
] as const;
export const API_CREDENTIAL_IDS = [
  MOCK_TENANCY_FIXTURE_IDS.apiCredential,
  "01ARZ3NDEKTSV4RRFFQ69G5FB4",
] as const;
export const WORKSPACE_IDS = [
  MOCK_TENANCY_FIXTURE_IDS.workspace,
  "01ARZ3NDEKTSV4RRFFQ69G5FBB",
] as const;
export const MEMBER_IDS = [MOCK_TENANCY_FIXTURE_IDS.member, "01ARZ3NDEKTSV4RRFFQ69G5FBC"] as const;
export const INVITATION_IDS = [
  MOCK_TENANCY_FIXTURE_IDS.invitation,
  "01ARZ3NDEKTSV4RRFFQ69G5FBD",
] as const;
const DEFAULT_MANIFEST_CONTENT_HASH =
  "sha256:111ac4229cdb08fcfbb49abdb8c447cc2a6c68a2190468dd31ee7db1ec0af353";
const ENVIRONMENT_TYPES = new Set(["custom", "development", "production", "staging"]);
export const TENANCY_PATH_PREFIXES = Object.values(TENANCY_PATHS);

export type TenancyMockResult =
  | { readonly matched: false }
  | { readonly error: string; readonly matched: true }
  | { readonly data: unknown; readonly matched: true };

export interface StoredAgentDefinition extends Record<string, unknown> {
  readonly draft: unknown;
  readonly id: string;
  readonly version: number;
}

export interface StoredAgentRelease extends Record<string, unknown> {
  readonly agentDefinitionId: string;
  readonly id: string;
  readonly manifest: unknown;
}

export interface StoredAgentDeployment extends Record<string, unknown> {
  readonly agentDefinitionId: string;
  readonly agentReleaseId: string;
  readonly desiredState: string;
  readonly id: string;
  readonly version: number;
}

export interface StoredWorkflowDefinition extends Record<string, unknown> {
  readonly draft: unknown;
  readonly environmentId: string;
  readonly id: string;
  readonly status: string;
  readonly version: number;
}

export interface StoredWorkflowRelease extends Record<string, unknown> {
  readonly definition: unknown;
  readonly environmentId: string;
  readonly id: string;
  readonly version: number;
  readonly workflowDefinitionId: string;
}

export interface StoredManagedSkillSource extends Record<string, unknown> {
  readonly id: string;
  readonly key: string;
  readonly status: string;
  readonly version: number;
}

export interface StoredManagedSkillRelease extends Record<string, unknown> {
  readonly id: string;
  readonly releaseVersion: string;
  readonly sourceId: string;
  readonly status: string;
  readonly version: number;
}

export interface StoredManagedSkill extends Record<string, unknown> {
  readonly id: string;
  readonly referencePaths: readonly string[];
  readonly releaseId: string;
  readonly sourceId: string;
}

export interface StoredManagedSkillInstallation extends Record<string, unknown> {
  readonly environmentId: string;
  readonly id: string;
  readonly managedSkillId: string;
  readonly managedSkillReleaseId: string;
  readonly version: number;
}

export interface StoredModelPolicy extends Record<string, unknown> {
  readonly environmentId: string;
  readonly id: string;
  readonly includeCuratedModels: boolean;
  readonly models: readonly string[];
  readonly status: "active" | "archived";
  readonly version: number;
}

interface StoredIdempotencyResult {
  readonly data: unknown;
  readonly fingerprint: string;
}

export interface TenancyMockState {
  readonly agentDefinitions: Map<string, StoredAgentDefinition>;
  readonly agentDeployments: Map<string, StoredAgentDeployment>;
  readonly agentReleases: Map<string, StoredAgentRelease>;
  readonly idempotencyResults: Map<string, StoredIdempotencyResult>;
  readonly managedSkillInstallations: Map<string, StoredManagedSkillInstallation>;
  readonly managedSkillReleases: Map<string, StoredManagedSkillRelease>;
  readonly managedSkills: Map<string, StoredManagedSkill>;
  readonly managedSkillSources: Map<string, StoredManagedSkillSource>;
  readonly modelPolicies: Map<string, StoredModelPolicy>;
  readonly workflowDefinitions: Map<string, StoredWorkflowDefinition>;
  readonly workflowReleases: Map<string, StoredWorkflowRelease>;
  nextId: number;
}

export function createTenancyMockState(): TenancyMockState {
  return {
    agentDefinitions: new Map(),
    agentDeployments: new Map(),
    agentReleases: new Map(),
    idempotencyResults: new Map(),
    managedSkillInstallations: new Map(),
    managedSkillReleases: new Map(),
    managedSkills: new Map(),
    managedSkillSources: new Map(),
    modelPolicies: new Map(),
    nextId: 10_000,
    workflowDefinitions: new Map(),
    workflowReleases: new Map(),
  };
}

export const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function nextPublicId(state: TenancyMockState): string {
  let value = state.nextId++;
  let suffix = "";
  for (let index = 0; index < 4; index += 1) {
    suffix = ULID_ALPHABET[value % ULID_ALPHABET.length]! + suffix;
    value = Math.floor(value / ULID_ALPHABET.length);
  }
  return `${MOCK_TENANCY_FIXTURE_IDS.agentDefinition.slice(0, -4)}${suffix}`;
}

export function canonicalValue(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonicalValue);
  if (input === null || typeof input !== "object") return input;
  return Object.fromEntries(
    Object.entries(input as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => [key, canonicalValue(value)]),
  );
}

export async function manifestContentHash(manifest: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonicalValue(manifest)));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

export function body(request: PlatformRequest): Readonly<Record<string, unknown>> {
  return typeof request.body === "object" && request.body !== null
    ? (request.body as Readonly<Record<string, unknown>>)
    : {};
}

export function optionalString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface MockListQuery {
  readonly cursor?: string;
  readonly limit?: number;
}

export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  try {
    const normalized = cursor.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const offset = Number(globalThis.atob(padded));
    if (Number.isSafeInteger(offset) && offset >= 0) return offset;
  } catch {
    // Fall through to the shared invalid-cursor error.
  }
  throw new TypeError("The pagination cursor is invalid.");
}

export function encodeCursor(offset: number): string {
  return globalThis
    .btoa(String(offset))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export function page<Item>(items: readonly Item[], query: MockListQuery) {
  const offset = decodeCursor(query.cursor);
  const limit = query.limit ?? 50;
  const selected = items.slice(offset, offset + limit);
  return {
    items: selected,
    nextCursor:
      offset + selected.length < items.length ? encodeCursor(offset + selected.length) : null,
  };
}

export function assertExpectedVersion(actual: number, expected: unknown) {
  if (expected !== actual) {
    throw new TypeError(`Expected resource version ${String(expected)} does not match ${actual}.`);
  }
}

export function assertDefinitionKeyAvailable(
  state: TenancyMockState,
  environmentId: string,
  slug: string,
  excludedId?: string,
) {
  const conflictsWithFixture =
    environmentId === MOCK_TENANCY_CONTEXT.environmentId &&
    slug === "mock.agent" &&
    excludedId !== MOCK_TENANCY_FIXTURE_IDS.agentDefinition;
  const conflictsWithStored = [...state.agentDefinitions.values()].some(
    (definition) =>
      definition.id !== excludedId &&
      definition.environmentId === environmentId &&
      definition.slug === slug,
  );
  if (conflictsWithFixture || conflictsWithStored) {
    throw new TypeError("Agent definition keys must be unique within an environment.");
  }
}

export function publicId(value: unknown, fallback: string, field: string) {
  if (value === undefined) return fallback;
  if (typeof value === "string" && PUBLIC_ID_PATTERN.test(value)) return value;
  throw new TypeError(`${field} must be a canonical ULID.`);
}

export function targetId(path: string, template: string) {
  const segments = path.split("/").filter(Boolean);
  const templateSegments = template.split("/").filter(Boolean);
  const index = templateSegments.indexOf(":id");
  return index < 0 ? undefined : segments[index];
}

export function scope(request: PlatformRequest) {
  return {
    environmentId: publicId(request.context?.environmentId, ENVIRONMENT_IDS[0], "environmentId"),
    organizationId: publicId(
      request.context?.organizationId,
      ORGANIZATION_IDS[0],
      "organizationId",
    ),
    projectId: publicId(request.context?.projectId, PROJECT_IDS[0], "projectId"),
  };
}

export function agentScope(request: PlatformRequest) {
  const environmentId = publicId(
    request.context?.environmentId,
    ENVIRONMENT_IDS[0],
    "environmentId",
  );
  const environmentIndex = ENVIRONMENT_IDS.indexOf(
    environmentId as (typeof ENVIRONMENT_IDS)[number],
  );
  if (environmentIndex < 0) throw new TypeError("Environment was not found.");
  return {
    environmentId,
    organizationId: ORGANIZATION_IDS[environmentIndex]!,
    projectId: PROJECT_IDS[environmentIndex]!,
  };
}

export function validateRouteScope(routeScope: ApiContextScope, request: PlatformRequest) {
  if (routeScope === "none") return;
  const field = `${routeScope}Id` as "environmentId" | "organizationId" | "projectId";
  const value = request.context?.[field];
  if (value === undefined) throw new TypeError(`${field} context is required.`);
  publicId(value, value, field);
}

function name(input: Readonly<Record<string, unknown>>, fallback: string) {
  return optionalString(input.name) ?? fallback;
}

function slug(input: Readonly<Record<string, unknown>>, fallbackName: string) {
  return resolveSlug({
    name: fallbackName,
    ...(optionalString(input.slug) ? { slug: input.slug as string } : {}),
  });
}

function scopes(input: Readonly<Record<string, unknown>>) {
  return Array.isArray(input.scopes) && input.scopes.every((value) => typeof value === "string")
    ? input.scopes
    : ["platform:read"];
}

export function organization(request: PlatformRequest, now: string, id: string, suffix: string) {
  const input = body(request);
  const resourceName = name(input, `Organization ${suffix}`);
  return {
    createdAt: now,
    id: publicId(id, ORGANIZATION_IDS[0], "organizationId"),
    name: resourceName,
    slug: slug(input, resourceName),
    status: "active",
    updatedAt: now,
    version: 1,
  };
}

export function project(request: PlatformRequest, now: string, id: string, suffix: string) {
  const input = body(request);
  const resourceName = name(input, `Project ${suffix}`);
  return {
    createdAt: now,
    id: publicId(id, PROJECT_IDS[0], "projectId"),
    name: resourceName,
    organizationId: scope(request).organizationId,
    slug: slug(input, resourceName),
    status: request.method === "DELETE" ? "archived" : "active",
    updatedAt: now,
    version: 1,
  };
}

export function environment(request: PlatformRequest, now: string, id: string, suffix: string) {
  const input = body(request);
  const resourceName = name(input, `Environment ${suffix}`);
  const requestedType = optionalString(input.type);
  const type =
    requestedType && ENVIRONMENT_TYPES.has(requestedType) ? requestedType : "development";
  return {
    createdAt: now,
    id: publicId(id, ENVIRONMENT_IDS[0], "environmentId"),
    name: resourceName,
    organizationId: scope(request).organizationId,
    projectId: scope(request).projectId,
    slug: slug(input, resourceName),
    status: request.method === "DELETE" ? "archived" : "active",
    type,
    updatedAt: now,
    version: 1,
  };
}

export function workspace(request: PlatformRequest, now: string, id: string, suffix: string) {
  const input = body(request);
  const resourceName = name(input, `Workspace ${suffix}`);
  return {
    createdAt: now,
    ...scope(request),
    ...(optionalString(input.description) ? { description: input.description } : {}),
    id: publicId(id, WORKSPACE_IDS[0], "workspaceId"),
    name: resourceName,
    slug: slug(input, resourceName),
    status: request.method === "DELETE" ? "archived" : "active",
    updatedAt: now,
    version: 1,
  };
}

export function organizationMember(request: PlatformRequest, now: string, id: string) {
  const input = body(request);
  const principalId = publicId(input.principalId ?? id, MEMBER_IDS[0], "principalId");
  const role = optionalString(input.role) ?? "member";
  return {
    createdAt: now,
    id: principalId,
    joinedAt: now,
    organizationId: request.context?.organizationId ?? ORGANIZATION_IDS[0],
    principalId,
    role,
    status: request.method === "DELETE" ? "removed" : "active",
    ...(request.method === "DELETE" ? { removedAt: now } : {}),
    updatedAt: now,
    version: 1,
  };
}

export function organizationInvitation(
  request: PlatformRequest,
  now: string,
  id: string,
  suffix: string,
) {
  const input = body(request);
  const status = request.method === "DELETE" ? "revoked" : "pending";
  return {
    createdAt: now,
    email: optionalString(input.email) ?? `invitee-${suffix}@example.test`,
    expiresAt:
      optionalString(input.expiresAt) ??
      new Date(Date.parse(now) + 7 * 24 * 60 * 60_000).toISOString(),
    id: publicId(id, INVITATION_IDS[0], "invitationId"),
    invitedByPrincipalId: MEMBER_IDS[0],
    organizationId: request.context?.organizationId ?? ORGANIZATION_IDS[0],
    ...(status === "revoked" ? { revokedAt: now } : {}),
    role: optionalString(input.role) ?? "member",
    status,
    updatedAt: now,
    version: 1,
  };
}

export function serviceAccount(request: PlatformRequest, now: string, id: string, suffix: string) {
  const input = body(request);
  return {
    createdAt: now,
    ...(optionalString(input.description) ? { description: input.description } : {}),
    ...scope(request),
    id: publicId(id, SERVICE_ACCOUNT_IDS[0], "serviceAccountId"),
    name: name(input, `Service account ${suffix}`),
    scopes: scopes(input),
    status: request.method === "DELETE" ? "disabled" : "active",
    updatedAt: now,
    version: 1,
  };
}

export function apiCredential(request: PlatformRequest, now: string, id: string, suffix: string) {
  const input = body(request);
  const status = request.method === "DELETE" ? "revoked" : "active";
  return {
    createdAt: now,
    ...scope(request),
    ...(optionalString(input.expiresAt) ? { expiresAt: input.expiresAt } : {}),
    id: publicId(id, API_CREDENTIAL_IDS[0], "apiCredentialId"),
    keyPrefix: "dpl_mock",
    name: name(input, `API key ${suffix}`),
    ...(status === "revoked" ? { revokedAt: now } : {}),
    scopes: scopes(input),
    serviceAccountId: publicId(input.serviceAccountId, SERVICE_ACCOUNT_IDS[0], "serviceAccountId"),
    status,
    updatedAt: now,
    version: 1,
  };
}

function defaultManifest() {
  return {
    apiVersion: "agents.deployments.ai/v1",
    kind: "Agent",
    metadata: { key: "mock.agent", name: "Mock Agent", version: "1.0.0" },
    spec: {
      instructions: "Complete the requested task.",
      model: { id: "openrouter/default" },
      sandbox: { mode: "none" },
    },
  } as const;
}

export function agentDefinition(request: PlatformRequest, now: string, id: string) {
  const input = body(request);
  const manifest =
    input.manifest && typeof input.manifest === "object" ? input.manifest : defaultManifest();
  const metadata = body({ ...request, body: (manifest as { metadata?: unknown }).metadata });
  return {
    createdAt: now,
    ...agentScope(request),
    draft: manifest,
    id: publicId(id, MOCK_TENANCY_FIXTURE_IDS.agentDefinition, "agentDefinitionId"),
    name: optionalString(metadata.name) ?? "Mock Agent",
    slug: optionalString(metadata.key) ?? "mock.agent",
    status: request.method === "DELETE" ? "archived" : "active",
    updatedAt: now,
    version: 0,
  };
}

export function agentDefinitionSummary(request: PlatformRequest, now: string, id: string) {
  const { draft: _, ...summary } = agentDefinition(request, now, id);
  return summary;
}

export function agentRelease(
  request: PlatformRequest,
  now: string,
  id: string,
  agentDefinitionId: string = MOCK_TENANCY_FIXTURE_IDS.agentDefinition,
  manifest: unknown = defaultManifest(),
  contentHash = DEFAULT_MANIFEST_CONTENT_HASH,
  releaseNumber = 1,
) {
  return {
    ...agentScope(request),
    agentDefinitionId,
    contentHash,
    createdAt: now,
    createdByPrincipalId: MOCK_TENANCY_FIXTURE_IDS.serviceAccount,
    id: publicId(id, MOCK_TENANCY_FIXTURE_IDS.agentRelease, "agentReleaseId"),
    manifest,
    releaseNumber,
    status: request.method === "DELETE" ? "archived" : "active",
    version: 0,
  };
}

export function agentReleaseSummary(
  request: PlatformRequest,
  now: string,
  id: string,
  agentDefinitionId: string = MOCK_TENANCY_FIXTURE_IDS.agentDefinition,
) {
  const { manifest: _, ...summary } = agentRelease(request, now, id, agentDefinitionId);
  return summary;
}
