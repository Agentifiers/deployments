import type { DynamoDatabaseService } from "./client-types.ts";
import { organizationAccess, type OrganizationAccess } from "./identity-federation/access.ts";
import type { Ulid } from "./ids.ts";
import { Keys, key } from "./keys.ts";

export interface PlatformHumanScopeAuthorizationInput {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly principalId: Ulid;
  readonly projectId: Ulid;
  readonly tokenSessionId?: Ulid;
}

function record(
  database: DynamoDatabaseService,
  key: { readonly pk: string; readonly sk: string },
) {
  return database.getRecord("control", key, true);
}

/**
 * Resolves a platform access token's requested tenant headers through live,
 * strongly consistent control-table state. Access tokens deliberately carry
 * no authoritative organization or role claims.
 */
export async function authorizePlatformHumanScope(
  database: DynamoDatabaseService,
  input: PlatformHumanScopeAuthorizationInput,
): Promise<OrganizationAccess> {
  const principal = await record(database, {
    pk: key("PRINCIPAL", input.principalId),
    sk: key("PRINCIPAL", input.principalId),
  });
  if (
    principal?.itemType !== "principal" ||
    principal.data.kind !== "human" ||
    principal.data.status !== "active"
  ) {
    return { kind: "denied" };
  }

  const environmentClaim = await record(
    database,
    Keys.control.uniqueClaim("environment-id", input.environmentId),
  );
  if (
    environmentClaim?.itemType !== "unique-claim" ||
    environmentClaim.data.ownerItemType !== "environment" ||
    environmentClaim.data.ownerId !== input.environmentId
  ) {
    return { kind: "denied" };
  }
  const environment = await record(database, {
    pk: environmentClaim.data.ownerPk,
    sk: environmentClaim.data.ownerSk,
  });
  if (
    environment?.itemType !== "environment" ||
    environment.data.id !== input.environmentId ||
    environment.data.organizationId !== input.organizationId ||
    environment.data.projectId !== input.projectId ||
    environment.data.status !== "active"
  ) {
    return { kind: "denied" };
  }

  return organizationAccess(database, {
    organizationId: input.organizationId,
    platformAdministrator: principal.data.platformRole === "administrator",
    principalId: input.principalId,
    ...(input.tokenSessionId ? { tokenSessionId: input.tokenSessionId } : {}),
  });
}
