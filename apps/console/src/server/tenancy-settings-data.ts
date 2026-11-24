import "@tanstack/react-start/server-only";
import type { TenancyRef, TenancyResource } from "../tenancy/settings.ts";
import { notFoundUnlessSignedOut } from "./admission.ts";
import { requirePublicIds } from "./console-data.ts";
import { callRoute } from "./platform-api.ts";

function settingsView(resource: TenancyResource): TenancyResource {
  const { createdAt, description, id, name, slug, status, updatedAt, version } = resource;
  return {
    createdAt,
    ...(description === undefined ? {} : { description }),
    id,
    name,
    slug,
    status,
    updatedAt,
    version,
  };
}

/** Reads the resource a settings page edits, at the scope its route sends. */
export async function readTenancyResource(
  accessToken: string,
  ref: TenancyRef,
): Promise<TenancyResource> {
  switch (ref.level) {
    case "organization": {
      const scope = { organizationId: ref.organizationId };
      return callRoute("getOrganization", { path: { id: ref.organizationId }, scope }, accessToken);
    }
    case "project": {
      const scope = { organizationId: ref.organizationId, projectId: ref.projectId };
      return callRoute("getProject", { path: { id: ref.projectId }, scope }, accessToken);
    }
    case "environment": {
      const { level: _level, ...scope } = ref;
      return callRoute("getEnvironment", { path: { id: ref.environmentId }, scope }, accessToken);
    }
    case "workspace": {
      const { level: _level, workspaceId, ...scope } = ref;
      return callRoute("getWorkspace", { path: { id: workspaceId }, scope }, accessToken);
    }
  }
}

export async function loadTenancyResource(
  accessToken: string,
  ref: TenancyRef,
): Promise<TenancyResource> {
  const { level: _level, ...ids } = ref;
  requirePublicIds(ids);
  const resource = await readTenancyResource(accessToken, ref).catch((error: unknown) =>
    notFoundUnlessSignedOut(error, () => callRoute("getIdentity", {}, accessToken)),
  );
  return settingsView(resource);
}
