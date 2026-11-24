import type { DynamoDatabaseService } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { Keys } from "../keys.ts";

export async function loadStanding(
  database: DynamoDatabaseService,
  organizationId: Ulid,
  consistent: boolean,
) {
  const stored = await database.getRecord(
    "control",
    Keys.control.organizationStanding(organizationId),
    consistent,
  );
  return stored?.itemType === "organization-standing" ? stored : undefined;
}
