import { makeOrganizationHoldReader, Ulid, type DynamoDatabaseService } from "@deployments-ai/db";
import { admitConsistently } from "@deployments-ai/organization-admission";
import { Schema } from "effect";

const decodeUlid = Schema.decodeUnknownSync(Ulid);

/**
 * An organization's active-sandbox limit, or zero while its standing refuses new sandboxes. Only
 * a new lease reads it, so sandboxes the organization already holds keep running.
 */
export function sandboxLeaseLimit(
  database: DynamoDatabaseService,
  activeSandboxes: (organizationId: string) => Promise<number>,
): (organizationId: string) => Promise<number> {
  const standing = makeOrganizationHoldReader(database);
  return async (organizationId) => {
    const { decision } = await admitConsistently({
      activity: "sandbox.lease",
      organizationId: decodeUlid(organizationId),
      standing,
    });
    return decision.kind === "suspended" ? 0 : activeSandboxes(organizationId);
  };
}
