import "@tanstack/react-start/server-only";
import {
  LEVEL_COPY,
  type ArchivableLevel,
  type GeneralChanges,
  type TenancyRef,
  type TenancyResource,
} from "../tenancy/settings.ts";
import { needsWrite } from "./expected-version.ts";
import { callRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";
import { readTenancyResource } from "./tenancy-settings-data.ts";

interface Mutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly ref: TenancyRef;
}

const UPDATE_OPERATIONS = {
  environment: "updateEnvironment",
  organization: "updateOrganization",
  project: "updateProject",
  workspace: "updateWorkspace",
} as const;

function update(
  { accessToken, idempotencyKey, ref }: Mutation,
  body: unknown,
): Promise<TenancyResource> {
  switch (ref.level) {
    case "organization": {
      const scope = { organizationId: ref.organizationId };
      return callRoute(
        "updateOrganization",
        {
          body: decodeRequestBody("updateOrganization", "UpdateOrganizationRequest", body),
          idempotencyKey,
          path: { id: ref.organizationId },
          scope,
        },
        accessToken,
      );
    }
    case "project": {
      const scope = { organizationId: ref.organizationId, projectId: ref.projectId };
      return callRoute(
        "updateProject",
        {
          body: decodeRequestBody("updateProject", "UpdateProjectRequest", body),
          idempotencyKey,
          path: { id: ref.projectId },
          scope,
        },
        accessToken,
      );
    }
    case "environment": {
      const { level: _level, ...scope } = ref;
      return callRoute(
        "updateEnvironment",
        {
          body: decodeRequestBody("updateEnvironment", "UpdateEnvironmentRequest", body),
          idempotencyKey,
          path: { id: ref.environmentId },
          scope,
        },
        accessToken,
      );
    }
    case "workspace": {
      const { level: _level, workspaceId, ...scope } = ref;
      return callRoute(
        "updateWorkspace",
        {
          body: decodeRequestBody("updateWorkspace", "UpdateWorkspaceRequest", body),
          idempotencyKey,
          path: { id: workspaceId },
          scope,
        },
        accessToken,
      );
    }
  }
}

/** Renames or re-slugs a resource the form read at `expectedVersion`. */
export async function updateTenancyResource({
  body,
  expectedVersion,
  ...mutation
}: Mutation & {
  readonly body: GeneralChanges;
  readonly expectedVersion: number;
}): Promise<TenancyResource> {
  const { level } = mutation.ref;
  const current = await readTenancyResource(mutation.accessToken, mutation.ref);
  const write = needsWrite(
    UPDATE_OPERATIONS[level],
    LEVEL_COPY[level].noun,
    { values: { ...current }, version: current.version },
    body,
    expectedVersion,
  );
  return write ? update(mutation, body) : current;
}

/** Archiving is idempotent in the API: an archived resource comes back unchanged. */
export function archiveTenancyResource({
  accessToken,
  idempotencyKey,
  ref,
}: Mutation & { readonly ref: Extract<TenancyRef, { readonly level: ArchivableLevel }> }) {
  switch (ref.level) {
    case "project": {
      const scope = { organizationId: ref.organizationId, projectId: ref.projectId };
      return callRoute(
        "archiveProject",
        { idempotencyKey, path: { id: ref.projectId }, scope },
        accessToken,
      );
    }
    case "environment": {
      const { level: _level, ...scope } = ref;
      return callRoute(
        "archiveEnvironment",
        { idempotencyKey, path: { id: ref.environmentId }, scope },
        accessToken,
      );
    }
    case "workspace": {
      const { level: _level, workspaceId, ...scope } = ref;
      return callRoute(
        "archiveWorkspace",
        { idempotencyKey, path: { id: workspaceId }, scope },
        accessToken,
      );
    }
  }
}
