import { Ulid, type OrganizationHoldReader } from "@deployments-ai/db";
import { admitConsistently } from "@deployments-ai/organization-admission";
import { Schema } from "effect";

const decodeUlid = Schema.decodeUnknownSync(Ulid);

/**
 * Whether the organization's standing refuses background jobs. A refused job is left as it was,
 * so its dispatcher sweep sends it again and it runs once every hold is released.
 */
export async function backgroundWorkSuspended(
  standing: OrganizationHoldReader,
  organizationId: string,
): Promise<boolean> {
  const { decision } = await admitConsistently({
    activity: "background.process",
    organizationId: decodeUlid(organizationId),
    standing,
  });
  return decision.kind === "suspended";
}
