import {
  beginBrainSearchPlacementMigration,
  completeBrainSearchPlacementMigration,
  getBrainSearchPlacement,
  type BrainSearchTarget,
  type DynamoDatabaseService,
} from "@deployments-ai/db";

export interface BrainSearchMigrationResult {
  readonly outcome: "migrated" | "unchanged";
  readonly target: BrainSearchTarget;
}

function sameLocation(left: BrainSearchTarget, right: BrainSearchTarget) {
  const origin = (target: BrainSearchTarget) => {
    const endpoint = target.location.openSearchEndpoint;
    return typeof endpoint === "string" ? new URL(endpoint).origin : undefined;
  };
  return (
    left.providerId === right.providerId &&
    origin(left) === origin(right) &&
    left.location.openSearchIndex === right.location.openSearchIndex &&
    left.location.region === right.location.region
  );
}

/**
 * Moves an organization's active Brain search placement to `target`'s location
 * through the placement's own migration transitions, so the record, its version
 * fence, and its semantic events stay canonical. An active placement already at
 * that location is left unchanged. A migration already in flight to the same
 * location is resumed with its recorded candidate and operation; one to another
 * location is refused. `prepare` runs against the candidate before cutover.
 * Documents indexed before the move are not re-enqueued.
 */
export async function migrateBrainSearchPlacement(input: {
  readonly actorPrincipalId: string;
  readonly database: DynamoDatabaseService;
  readonly generateId: () => Promise<string>;
  readonly now: () => string;
  readonly organizationId: string;
  readonly prepare?: (target: BrainSearchTarget) => Promise<void>;
  readonly target: BrainSearchTarget;
}): Promise<BrainSearchMigrationResult> {
  let placement = await getBrainSearchPlacement(input.database, input.organizationId);
  if (placement?.data.phase !== "active" || !placement.data.readTarget) {
    throw new Error("Only an active Brain search placement can be migrated.");
  }
  if (placement.data.candidateTarget) {
    if (!sameLocation(placement.data.candidateTarget, input.target)) {
      throw new Error("Another Brain search migration is in progress to a different location.");
    }
  } else {
    if (sameLocation(placement.data.readTarget, input.target)) {
      return { outcome: "unchanged", target: placement.data.readTarget };
    }
    placement = await beginBrainSearchPlacementMigration({
      actorPrincipalId: input.actorPrincipalId,
      database: input.database,
      eventId: await input.generateId(),
      now: input.now(),
      operationId: await input.generateId(),
      organizationId: input.organizationId,
      target: input.target,
    });
  }
  const candidate = placement.data.candidateTarget;
  const operationId = placement.data.operationId;
  if (!candidate || !operationId) {
    throw new Error("Brain search placement has no migration to complete.");
  }
  await input.prepare?.(candidate);
  const completed = await completeBrainSearchPlacementMigration({
    actorPrincipalId: input.actorPrincipalId,
    database: input.database,
    eventId: await input.generateId(),
    now: input.now(),
    operationId,
    organizationId: input.organizationId,
  });
  if (!completed.data.readTarget) {
    throw new Error("Brain search migration completed without a read target.");
  }
  return { outcome: "migrated", target: completed.data.readTarget };
}
