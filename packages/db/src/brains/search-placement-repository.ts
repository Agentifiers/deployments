import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { key } from "../keys.ts";
import { BrainSearchPlacementRecord, type BrainSearchTarget } from "../records/brain-search.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { brainUlid } from "./record-mapping.ts";
import {
  activeHumanCondition,
  activeMemberCondition,
  activeOrganizationCondition,
} from "./authorization-conditions.ts";

export type BrainSearchPlacement = typeof BrainSearchPlacementRecord.Type;

export async function getBrainSearchPlacement(
  database: DynamoDatabaseService,
  organizationId: string,
) {
  const value = await database.getRecord(
    "control",
    {
      pk: key("ORG", organizationId),
      sk: key("BRAIN-SEARCH-PLACEMENT", organizationId),
    },
    true,
  );
  return value?.itemType === "brain-search-placement" ? value : undefined;
}

function validateTarget(target: BrainSearchTarget) {
  const kinds = new Set(target.components.map((component) => component.kind));
  if (
    target.components.length !== 4 ||
    !(["dense", "entity", "exact", "lexical"] as const).every((kind) => kinds.has(kind)) ||
    new Set(target.components.map((component) => component.componentId)).size !== 4
  ) {
    throw new TypeError(
      "Brain search targets require unique dense, lexical, exact, and entity components.",
    );
  }
}

/**
 * Returns the organization's Brain search placement, creating the unconfigured
 * envelope for an active organization that predates Brain placement creation.
 */
export async function ensureBrainSearchPlacement(input: {
  readonly database: DynamoDatabaseService;
  readonly now: string;
  readonly organizationId: string;
}) {
  const existing = await getBrainSearchPlacement(input.database, input.organizationId);
  if (existing) return existing;
  const envelope = Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
    withCanonicalRecordKeys({
      data: {
        createdAt: input.now,
        generation: 0,
        organizationId: brainUlid(input.organizationId),
        phase: "unconfigured" as const,
        updatedAt: input.now,
        version: 0,
      },
      itemType: "brain-search-placement" as const,
    }),
  );
  try {
    await input.database.transactWrite([
      activeOrganizationCondition(input.organizationId),
      { kind: "put", record: envelope },
    ]);
  } catch (cause) {
    const reconciled = await getBrainSearchPlacement(input.database, input.organizationId);
    if (reconciled) return reconciled;
    throw cause;
  }
  return envelope;
}

/**
 * Who activates a placement: an organization owner through operator tooling, or the platform
 * activating the install's default target for a new organization.
 */
export type BrainSearchPlacementActor =
  | { readonly principalId: string; readonly type: "principal" }
  | { readonly type: "system" };

export async function activateBrainSearchPlacement(input: {
  readonly actor: BrainSearchPlacementActor;
  readonly database: DynamoDatabaseService;
  readonly eventId: string;
  readonly now: string;
  readonly organizationId: string;
  readonly target: BrainSearchTarget;
}) {
  validateTarget(input.target);
  const previous = await getBrainSearchPlacement(input.database, input.organizationId);
  if (!previous || previous.data.phase !== "unconfigured") {
    throw new TypeError("Only an unconfigured Brain search placement can be activated.");
  }
  const next = Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
    withCanonicalRecordKeys({
      ...previous,
      data: {
        ...previous.data,
        generation: previous.data.generation + 1,
        phase: "active" as const,
        readTarget: input.target,
        updatedAt: input.now,
        version: previous.data.version + 1,
        writeTarget: input.target,
      },
    }),
  );
  const event = makeSemanticEventRecord({
    actor:
      input.actor.type === "principal"
        ? { id: brainUlid(input.actor.principalId), type: "principal" }
        : { type: "system" },
    aggregateId: brainUlid(input.organizationId),
    aggregateType: "brain-search-placement",
    aggregateVersion: next.data.generation,
    eventId: brainUlid(input.eventId),
    eventType: "brain-search-placement.activated",
    occurredAt: input.now,
    organizationId: brainUlid(input.organizationId),
    payload: {
      generation: next.data.generation,
      providerId: input.target.providerId,
      targetId: input.target.targetId,
    },
  });
  await transactWithSemanticEvents(
    input.database,
    [
      activeOrganizationCondition(input.organizationId),
      ...(input.actor.type === "principal"
        ? [
            activeHumanCondition(input.actor.principalId),
            activeMemberCondition(input.organizationId, input.actor.principalId, true),
          ]
        : []),
      { kind: "put", previousRecord: previous, record: next },
    ],
    [event],
    input.eventId,
  );
  return next;
}

export async function beginBrainSearchPlacementMigration(input: {
  readonly actorPrincipalId: string;
  readonly database: DynamoDatabaseService;
  readonly eventId: string;
  readonly now: string;
  readonly operationId: string;
  readonly organizationId: string;
  readonly target: BrainSearchTarget;
}) {
  validateTarget(input.target);
  const previous = await getBrainSearchPlacement(input.database, input.organizationId);
  if (
    !previous ||
    previous.data.phase !== "active" ||
    !previous.data.readTarget ||
    !previous.data.writeTarget ||
    previous.data.candidateTarget ||
    previous.data.operationId
  ) {
    throw new TypeError("Only a stable active Brain search placement can begin migration.");
  }
  if (previous.data.readTarget.targetId === input.target.targetId) {
    throw new TypeError("A Brain search migration requires a new target ID.");
  }
  const next = Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
    withCanonicalRecordKeys({
      ...previous,
      data: {
        ...previous.data,
        candidateTarget: input.target,
        generation: previous.data.generation + 1,
        operationId: brainUlid(input.operationId),
        updatedAt: input.now,
        version: previous.data.version + 1,
      },
    }),
  );
  const event = makeSemanticEventRecord({
    actor: { id: brainUlid(input.actorPrincipalId), type: "principal" },
    aggregateId: brainUlid(input.organizationId),
    aggregateType: "brain-search-placement",
    aggregateVersion: next.data.generation,
    eventId: brainUlid(input.eventId),
    eventType: "brain-search-placement.migration-requested",
    occurredAt: input.now,
    organizationId: brainUlid(input.organizationId),
    payload: {
      generation: next.data.generation,
      providerId: input.target.providerId,
      targetId: input.target.targetId,
    },
  });
  await transactWithSemanticEvents(
    input.database,
    [
      activeOrganizationCondition(input.organizationId),
      activeHumanCondition(input.actorPrincipalId),
      activeMemberCondition(input.organizationId, input.actorPrincipalId, true),
      { kind: "put", previousRecord: previous, record: next },
    ],
    [event],
    input.eventId,
  );
  return next;
}

export async function completeBrainSearchPlacementMigration(input: {
  readonly actorPrincipalId: string;
  readonly database: DynamoDatabaseService;
  readonly eventId: string;
  readonly now: string;
  readonly operationId: string;
  readonly organizationId: string;
}) {
  const previous = await getBrainSearchPlacement(input.database, input.organizationId);
  if (
    !previous ||
    previous.data.phase !== "active" ||
    !previous.data.candidateTarget ||
    previous.data.operationId !== input.operationId
  ) {
    throw new TypeError("Brain search placement has no matching active migration.");
  }
  const target = previous.data.candidateTarget;
  const next = Schema.decodeUnknownSync(BrainSearchPlacementRecord)(
    withCanonicalRecordKeys({
      ...previous,
      data: {
        createdAt: previous.data.createdAt,
        generation: previous.data.generation + 1,
        organizationId: previous.data.organizationId,
        phase: "active" as const,
        readTarget: target,
        updatedAt: input.now,
        version: previous.data.version + 1,
        writeTarget: target,
      },
    }),
  );
  const event = makeSemanticEventRecord({
    actor: { id: brainUlid(input.actorPrincipalId), type: "principal" },
    aggregateId: brainUlid(input.organizationId),
    aggregateType: "brain-search-placement",
    aggregateVersion: next.data.generation,
    eventId: brainUlid(input.eventId),
    eventType: "brain-search-placement.migrated",
    occurredAt: input.now,
    organizationId: brainUlid(input.organizationId),
    payload: {
      generation: next.data.generation,
      providerId: target.providerId,
      targetId: target.targetId,
    },
  });
  await transactWithSemanticEvents(
    input.database,
    [
      activeOrganizationCondition(input.organizationId),
      activeHumanCondition(input.actorPrincipalId),
      activeMemberCondition(input.organizationId, input.actorPrincipalId, true),
      { kind: "put", previousRecord: previous, record: next },
    ],
    [event],
    input.eventId,
  );
  return next;
}
