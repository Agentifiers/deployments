import "@tanstack/react-start/server-only";
import type {
  EnvironmentResponse,
  OrganizationResponse,
  ProjectResponse,
  SystemInstallationResponse,
} from "@deployments-ai/api-contract";
import { PUBLIC_ID_PATTERN } from "@deployments-ai/api-contract/primitives";
import { notFound } from "@tanstack/react-router";
import { PlatformApiError } from "../errors.ts";
import { operationAccess, type OperationAccess } from "../access.ts";
import type { ConsoleAuthorization } from "../permissions.ts";
import { notFoundUnlessSignedOut } from "./admission.ts";
import { callRoute, collectPages, type RouteResponse } from "./platform-api.ts";

type OrganizationSummary = Pick<
  OrganizationResponse,
  "createdAt" | "id" | "name" | "slug" | "status" | "updatedAt"
>;
type ProjectSummary = Pick<ProjectResponse, "id" | "name" | "slug" | "status">;
export type EnvironmentSummary = Pick<
  EnvironmentResponse,
  | "createdAt"
  | "id"
  | "name"
  | "organizationId"
  | "projectId"
  | "slug"
  | "status"
  | "type"
  | "updatedAt"
>;
export type SystemInstallationSummary = Pick<
  (typeof SystemInstallationResponse)["Type"],
  | "awsAccountId"
  | "awsRegion"
  | "deployedAt"
  | "deployedBy"
  | "endpoints"
  | "profile"
  | "releaseManifestSha256"
  | "sourceCommit"
  | "targetName"
>;

export interface OrganizationShell {
  readonly access: OperationAccess;
  readonly authorization: ConsoleAuthorization;
  readonly organization: OrganizationSummary;
  readonly organizations: readonly OrganizationSummary[];
  readonly principalId: string;
  /** The caller's own member name and email, when they can read members and are one. */
  readonly profile?: { readonly displayName?: string; readonly primaryEmail?: string };
  readonly projects: readonly {
    readonly environments: readonly EnvironmentSummary[];
    readonly project: ProjectSummary;
  }[];
}

const PAGE_LIMIT = 100;

/** Route parameters are public IDs; anything else cannot name a resource. */
export function requirePublicIds(ids: Readonly<Record<string, string>>) {
  for (const id of Object.values(ids)) {
    if (!PUBLIC_ID_PATTERN.test(id)) throw notFound();
  }
}

function organizationSummary(organization: OrganizationResponse): OrganizationSummary {
  const { createdAt, id, name, slug, status, updatedAt } = organization;
  return { createdAt, id, name, slug, status, updatedAt };
}

function environmentSummary(environment: EnvironmentResponse): EnvironmentSummary {
  const { createdAt, id, name, organizationId, projectId, slug, status, type, updatedAt } =
    environment;
  return { createdAt, id, name, organizationId, projectId, slug, status, type, updatedAt };
}

export async function loadOrganizations(accessToken: string) {
  const organizations = await collectPages((cursor) =>
    callRoute("listOrganizations", { query: { cursor, limit: PAGE_LIMIT } }, accessToken),
  );
  return organizations.map(organizationSummary);
}

export async function loadOrganizationShell(
  accessToken: string,
  organizationId: string,
): Promise<OrganizationShell> {
  requirePublicIds({ organizationId });
  const scope = { organizationId };
  const organizationsLoad = loadOrganizations(accessToken);
  const [[identity, organization, projects], organizations] = await Promise.all([
    Promise.all([
      callRoute("getIdentity", { scope }, accessToken),
      callRoute("getOrganization", { path: { id: organizationId }, scope }, accessToken),
      collectPages((cursor) =>
        callRoute("listProjects", { query: { cursor, limit: PAGE_LIMIT }, scope }, accessToken),
      ),
    ]).catch((error: unknown) => notFoundUnlessSignedOut(error, () => organizationsLoad)),
    organizationsLoad,
  ]);
  const authorization: ConsoleAuthorization = {
    capabilities: identity.capabilities,
    ...(identity.organizationRole ? { organizationRole: identity.organizationRole } : {}),
    ...(identity.platformRole ? { platformRole: identity.platformRole } : {}),
  };
  const profileLoad = loadOwnProfile(accessToken, organizationId, identity.id, authorization);
  const projectEnvironments = await Promise.all(
    projects.map(async (project) => ({
      environments: (
        await collectPages((cursor) =>
          callRoute(
            "listEnvironments",
            {
              query: { cursor, limit: PAGE_LIMIT },
              scope: { organizationId, projectId: project.id },
            },
            accessToken,
          ),
        )
      ).map(environmentSummary),
      project: { id: project.id, name: project.name, slug: project.slug, status: project.status },
    })),
  );
  const profile = await profileLoad;
  return {
    access: operationAccess(authorization),
    authorization,
    organization: organizationSummary(organization),
    organizations,
    principalId: identity.id,
    ...(profile ? { profile } : {}),
    projects: projectEnvironments,
  };
}

/**
 * The caller's name and email for the account menu, from their own member record. The menu falls
 * back to the principal ID, so a caller who cannot read members, such as a platform
 * administrator outside the organization, or a failed read leaves it out.
 */
async function loadOwnProfile(
  accessToken: string,
  organizationId: string,
  principalId: string,
  authorization: ConsoleAuthorization,
): Promise<OrganizationShell["profile"]> {
  if (!authorization.capabilities.includes("members:read")) return undefined;
  try {
    const members = await collectPages((cursor) =>
      callRoute(
        "listOrganizationMembers",
        { query: { cursor, limit: PAGE_LIMIT }, scope: { organizationId } },
        accessToken,
      ),
    );
    const own = members.find((member) => member.principalId === principalId);
    if (!own || (own.displayName === undefined && own.primaryEmail === undefined)) return undefined;
    return {
      ...(own.displayName === undefined ? {} : { displayName: own.displayName }),
      ...(own.primaryEmail === undefined ? {} : { primaryEmail: own.primaryEmail }),
    };
  } catch {
    return undefined;
  }
}

export async function loadEnvironment(
  accessToken: string,
  input: {
    readonly environmentId: string;
    readonly organizationId: string;
    readonly projectId: string;
  },
): Promise<EnvironmentSummary> {
  requirePublicIds(input);
  const environment = await callRoute(
    "getEnvironment",
    { path: { id: input.environmentId }, scope: input },
    accessToken,
  ).catch((error: unknown) =>
    notFoundUnlessSignedOut(error, () => callRoute("getIdentity", {}, accessToken)),
  );
  if (
    environment.organizationId !== input.organizationId ||
    environment.projectId !== input.projectId
  ) {
    throw notFound();
  }
  return environmentSummary(environment);
}

/** The install record, or `null` until the first verified deploy records it. */
export async function loadSystemInstallation(
  accessToken: string,
): Promise<SystemInstallationSummary | null> {
  try {
    const installation = await callRoute("getSystemInstallation", {}, accessToken);
    return {
      awsAccountId: installation.awsAccountId,
      awsRegion: installation.awsRegion,
      deployedAt: installation.deployedAt,
      deployedBy: installation.deployedBy,
      endpoints: installation.endpoints,
      profile: installation.profile,
      releaseManifestSha256: installation.releaseManifestSha256,
      sourceCommit: installation.sourceCommit,
      targetName: installation.targetName,
    };
  } catch (error) {
    if (error instanceof PlatformApiError && error.problem.code === "installation_not_recorded") {
      return null;
    }
    throw error;
  }
}

/** The signed-in principal, read without an organization header. */
export async function loadSessionIdentity(accessToken: string) {
  const identity = await callRoute("getIdentity", {}, accessToken);
  return { principalId: identity.id };
}

/**
 * `whoami` reveals the platform role only with an organization header, which a caller without
 * organizations cannot send, so the cheapest platform-administrator route answers instead.
 */
export async function loadPlatformAdministrator(accessToken: string): Promise<boolean> {
  try {
    await callRoute("listSystemOrganizations", { query: { limit: 1 } }, accessToken);
    return true;
  } catch (error) {
    if (error instanceof PlatformApiError && error.problem.status === 403) return false;
    throw error;
  }
}

export type SystemOrganizationView = RouteResponse<"listSystemOrganizations">["items"][number];

export async function loadSystemOrganizationPage(
  accessToken: string,
  cursor: string | undefined,
): Promise<{ readonly items: readonly SystemOrganizationView[]; readonly nextCursor?: string }> {
  const page = await callRoute(
    "listSystemOrganizations",
    { query: { cursor, limit: PAGE_LIMIT } },
    accessToken,
  );
  return page.nextCursor === null
    ? { items: page.items }
    : { items: page.items, nextCursor: page.nextCursor };
}
