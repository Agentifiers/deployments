import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  QueryCommand,
  type DynamoDBDocumentClient,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { Effect } from "effect";
import type { TransactionConditionCheck, TransactionOperation } from "../client-types.ts";
import type { Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import {
  decodePlatformRecord,
  tableForItemType,
  withCanonicalRecordKeys,
  type PlatformRecord,
} from "../records/index.ts";
import { laneRequirementTerm, type OrganizationGateRequirement } from "./requirements.ts";

/**
 * Copies of the gate state per organization. Two unrelated transactions in one organization
 * condition-check the same lane with probability 1 / ORGANIZATION_GATE_LANE_COUNT. Changing the
 * count is a persisted-data migration.
 */
export const ORGANIZATION_GATE_LANE_COUNT = 32;

export type OrganizationGateLane = Extract<
  PlatformRecord,
  { readonly itemType: "organization-gate-lane" }
>;
export type OrganizationGateState = Omit<
  OrganizationGateLane["data"],
  "createdAt" | "lane" | "updatedAt" | "version"
>;
type TransactItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

const GATE_SOURCE_ITEM_TYPES = {
  "brain-search-placement": true,
  "erasure-fence": true,
  "memory-provider-mutation-gate": true,
  "memory-search-mutation-fence": true,
  "memory-search-placement": true,
  organization: true,
} as const;

/** A record whose state every organization gate lane copies. */
export type OrganizationGateSource = Extract<
  PlatformRecord,
  { readonly itemType: keyof typeof GATE_SOURCE_ITEM_TYPES }
>;

export function isOrganizationGateSource(record: PlatformRecord): record is OrganizationGateSource {
  return Object.hasOwn(GATE_SOURCE_ITEM_TYPES, record.itemType);
}

export function isOrganizationGateLane(record: PlatformRecord): record is OrganizationGateLane {
  return record.itemType === "organization-gate-lane";
}

export function organizationGateSourceOrganizationId(record: OrganizationGateSource): Ulid {
  return record.itemType === "organization" ? record.data.id : record.data.organizationId;
}

/** A gate source written (`present`) or deleted by one transaction. */
export interface OrganizationGateChange {
  readonly present: boolean;
  readonly record: OrganizationGateSource;
}

/** The gate state once `change` commits; undefined once the organization is gone. */
function applyGateChange(
  state: OrganizationGateState | undefined,
  { present, record }: OrganizationGateChange,
): OrganizationGateState | undefined {
  if (!state) return undefined;
  switch (record.itemType) {
    case "organization":
      return present ? { ...state, organization: { status: record.data.status } } : undefined;
    case "erasure-fence": {
      const { erasureFence: _previous, ...rest } = state;
      const { leaseExpiresAt, operationId } = record.data;
      return present
        ? { ...rest, erasureFence: { operationId, ...(leaseExpiresAt ? { leaseExpiresAt } : {}) } }
        : rest;
    }
    case "memory-search-placement": {
      const { memorySearchPlacement: _previous, ...rest } = state;
      const { generation, version } = record.data;
      return present ? { ...rest, memorySearchPlacement: { generation, version } } : rest;
    }
    case "memory-search-mutation-fence": {
      const { memorySearchMutationFence: _previous, ...rest } = state;
      const { epoch, status, version } = record.data;
      return present ? { ...rest, memorySearchMutationFence: { epoch, status, version } } : rest;
    }
    case "memory-provider-mutation-gate": {
      const { [record.data.targetId]: _previous, ...gates } = state.memoryProviderGates;
      return {
        ...state,
        memoryProviderGates: present
          ? { ...gates, [record.data.targetId]: record.data.status }
          : gates,
      };
    }
    case "brain-search-placement": {
      const { brainSearchPlacement: _previous, ...rest } = state;
      const { generation, phase, version } = record.data;
      return present ? { ...rest, brainSearchPlacement: { generation, phase, version } } : rest;
    }
    default: {
      const _exhaustive: never = record;
      return _exhaustive;
    }
  }
}

function emptyGateState(organizationId: Ulid): OrganizationGateState {
  return { memoryProviderGates: {}, organization: { status: "active" }, organizationId };
}

function applyGateChanges(
  state: OrganizationGateState | undefined,
  changes: readonly OrganizationGateChange[],
) {
  return changes.reduce(applyGateChange, state);
}

/**
 * The gate state an organization's stored gate sources define, or undefined when the organization
 * record is absent. Every lane of the organization holds exactly this state.
 */
export function organizationGateState(
  organizationId: Ulid,
  sources: readonly OrganizationGateSource[],
): OrganizationGateState | undefined {
  const own = sources.filter(
    (source) => organizationGateSourceOrganizationId(source) === organizationId,
  );
  if (!own.some((source) => source.itemType === "organization")) return undefined;
  return applyGateChanges(
    emptyGateState(organizationId),
    own.map((record) => ({ present: true, record })),
  );
}

/** The changes `operations` make to gate state, by organization. Writes the lanes ignore are left out. */
function gateChanges(operations: readonly TransactionOperation[]) {
  const changes = new Map<Ulid, OrganizationGateChange[]>();
  for (const operation of operations) {
    if (operation.kind === "condition-check" || !isOrganizationGateSource(operation.record))
      continue;
    const organizationId = organizationGateSourceOrganizationId(operation.record);
    const previous =
      operation.kind === "put" &&
      operation.previousRecord &&
      isOrganizationGateSource(operation.previousRecord)
        ? operation.previousRecord
        : undefined;
    if (
      previous &&
      isDeepStrictEqual(
        applyGateChange(emptyGateState(organizationId), { present: true, record: previous }),
        applyGateChange(emptyGateState(organizationId), {
          present: true,
          record: operation.record,
        }),
      )
    ) {
      continue;
    }
    changes.set(organizationId, [
      ...(changes.get(organizationId) ?? []),
      { present: operation.kind === "put", record: operation.record },
    ]);
  }
  return changes;
}

function createsOrganization(
  changes: readonly OrganizationGateChange[],
  operations: readonly TransactionOperation[],
) {
  return operations.some(
    (operation) =>
      operation.kind === "put" &&
      operation.record.itemType === "organization" &&
      !operation.previousRecord &&
      changes.some((change) => change.record === operation.record),
  );
}

function laneRecord(
  state: OrganizationGateState,
  lane: number,
  at: string,
  previous?: OrganizationGateLane,
) {
  return withCanonicalRecordKeys({
    data: {
      ...state,
      createdAt: previous?.data.createdAt ?? at,
      lane,
      updatedAt: at,
      version: previous ? previous.data.version + 1 : 0,
    },
    itemType: "organization-gate-lane" as const,
  }) as OrganizationGateLane;
}

function laneState({
  createdAt: _createdAt,
  lane: _lane,
  updatedAt: _updatedAt,
  version: _version,
  ...state
}: OrganizationGateLane["data"]): OrganizationGateState {
  return state;
}

function changeTime(changes: readonly OrganizationGateChange[]) {
  return changes
    .map(({ record }) => {
      const data = record.data as { readonly createdAt?: string; readonly updatedAt?: string };
      return data.updatedAt ?? data.createdAt ?? "";
    })
    .reduce((latest, time) => (time > latest ? time : latest), "");
}

type LaneWrite =
  | { readonly kind: "absent"; readonly lane: number; readonly organizationId: string }
  | { readonly kind: "create"; readonly record: OrganizationGateLane }
  | {
      readonly kind: "update";
      readonly previous: OrganizationGateLane;
      readonly record: OrganizationGateLane;
    }
  | { readonly kind: "delete"; readonly previous: OrganizationGateLane };

/**
 * The writes that leave all lanes equal to `next`, or every lane gone when it is undefined (a lane
 * that is already missing is checked absent, so none can appear concurrently). Lanes already equal
 * to `next` are left alone, and missing lanes are created.
 */
function laneWritesTo(
  organizationId: string,
  next: OrganizationGateState | undefined,
  stored: readonly OrganizationGateLane[],
  at: string,
): readonly LaneWrite[] {
  const byLane = new Map(stored.map((lane) => [lane.data.lane, lane]));
  return Array.from({ length: ORGANIZATION_GATE_LANE_COUNT }, (_, lane): LaneWrite => {
    const previous = byLane.get(lane);
    if (!next) {
      return previous ? { kind: "delete", previous } : { kind: "absent", lane, organizationId };
    }
    if (!previous) return { kind: "create", record: laneRecord(next, lane, at) };
    return { kind: "update", previous, record: laneRecord(next, lane, at, previous) };
  }).filter(
    (write) => write.kind !== "update" || !isDeepStrictEqual(laneState(write.previous.data), next),
  );
}

/**
 * The lane writes that keep every lane equal to the gate state once `changes` commit. An
 * organization created by these changes gets its lanes. An organization without lanes (created
 * before lanes existed and not yet reconciled) gets none, so its tenant writes stay refused until
 * `reconcileOrganizationGateLanes` creates them; the change checks every lane absent, so a
 * reconcile that creates them first cancels it instead of leaving them stale.
 */
function laneWrites(
  organizationId: Ulid,
  changes: readonly OrganizationGateChange[],
  creating: boolean,
  stored: readonly OrganizationGateLane[],
): readonly LaneWrite[] {
  const at = changeTime(changes) || new Date().toISOString();
  if (creating) {
    return laneWritesTo(
      organizationId,
      applyGateChanges(emptyGateState(organizationId), changes),
      [],
      at,
    );
  }
  const first = stored[0];
  if (!first) {
    return Array.from(
      { length: ORGANIZATION_GATE_LANE_COUNT },
      (_, lane): LaneWrite => ({ kind: "absent", lane, organizationId }),
    );
  }
  return laneWritesTo(organizationId, applyGateChanges(laneState(first.data), changes), stored, at);
}

function laneWriteOperation(write: LaneWrite): TransactionOperation {
  switch (write.kind) {
    case "absent":
      return {
        conditionExpression: "attribute_not_exists(pk)",
        key: organizationGateLaneKey(write.organizationId, write.lane),
        kind: "condition-check",
        table: "control",
      };
    case "create":
      return { kind: "put", record: write.record };
    case "update":
      return { kind: "put", previousRecord: write.previous, record: write.record };
    case "delete":
      return { kind: "delete", record: write.previous };
  }
}

/**
 * Lane writes for every organization whose gate state `operations` change, to append to the same
 * transaction. `readLanes` returns an organization's stored lanes from a strongly consistent read.
 */
export function organizationGateLaneWrites<E>(
  operations: readonly TransactionOperation[],
  readLanes: (organizationId: Ulid) => Effect.Effect<readonly OrganizationGateLane[], E>,
): Effect.Effect<readonly TransactionOperation[], E> {
  return Effect.forEach([...gateChanges(operations)], ([organizationId, changes]) =>
    createsOrganization(changes, operations)
      ? Effect.succeed(laneWrites(organizationId, changes, true, []))
      : readLanes(organizationId).pipe(
          Effect.map((stored) => laneWrites(organizationId, changes, false, stored)),
        ),
  ).pipe(Effect.map((writes) => writes.flat().map(laneWriteOperation)));
}

/** How many lane writes {@link organizationGateLaneWrites} adds at most. */
export function organizationGateLaneWriteCount(operations: readonly TransactionOperation[]) {
  return gateChanges(operations).size * ORGANIZATION_GATE_LANE_COUNT;
}

export function organizationGateLaneKey(organizationId: string, lane: number) {
  return {
    pk: key("ORG", organizationId),
    sk: key("ORGANIZATION-GATE-LANE", String(lane).padStart(2, "0")),
  };
}

/** The lane a transaction checks: a digest of the items it writes, so retries pick the same lane. */
export function organizationGateLane(operations: readonly TransactionOperation[]) {
  const items = operations
    .map((operation) =>
      operation.kind === "condition-check"
        ? `${operation.table}\0${operation.key.pk}\0${operation.key.sk}`
        : `${tableForItemType(operation.record.itemType)}\0${operation.record.pk}\0${operation.record.sk}`,
    )
    .sort();
  const digest = createHash("sha256").update(items.join("\n")).digest("hex");
  return Number.parseInt(digest.slice(0, 8), 16) % ORGANIZATION_GATE_LANE_COUNT;
}

export type OrganizationGateFence =
  | { readonly kind: "tenant"; readonly observedAt: string }
  | { readonly kind: "erasure-owner"; readonly operationId: string };

/**
 * One condition check on one lane: the organization exists, no unexpired governance fence holds it
 * (or, for the erasure owner, its own fence does), and every requirement holds.
 */
export function organizationGateLaneCheck(input: {
  readonly fence: OrganizationGateFence;
  readonly lane: number;
  readonly organizationId: string;
  readonly requirements: readonly OrganizationGateRequirement[];
}): TransactionConditionCheck {
  const fence =
    input.fence.kind === "tenant"
      ? {
          conditionExpression:
            "(attribute_not_exists(#gate.#gateFence) OR #gate.#gateFence.#gateFenceLease <= :gateObservedAt)",
          expressionAttributeNames: {
            "#gateFence": "erasureFence",
            "#gateFenceLease": "leaseExpiresAt",
          },
          expressionAttributeValues: { ":gateObservedAt": input.fence.observedAt },
        }
      : {
          conditionExpression: "#gate.#gateFence.#gateFenceOperation = :gateFenceOperation",
          expressionAttributeNames: {
            "#gateFence": "erasureFence",
            "#gateFenceOperation": "operationId",
          },
          expressionAttributeValues: { ":gateFenceOperation": input.fence.operationId },
        };
  const terms = [fence, ...input.requirements.map(laneRequirementTerm)];
  return {
    conditionExpression: [
      "attribute_exists(pk)",
      ...terms.map((term) => term.conditionExpression),
    ].join(" AND "),
    expressionAttributeNames: Object.assign(
      { "#gate": "data" },
      ...terms.map((term) => term.expressionAttributeNames),
    ),
    expressionAttributeValues: Object.assign(
      {},
      ...terms.map((term) => term.expressionAttributeValues),
    ),
    key: organizationGateLaneKey(input.organizationId, input.lane),
    kind: "condition-check",
    table: "control",
  };
}

/** An organization's lanes, read strongly consistent, in lane order. */
export async function readOrganizationGateLanes(
  client: DynamoDBDocumentClient,
  controlTable: string,
  organizationId: string,
): Promise<readonly OrganizationGateLane[]> {
  const result = await client.send(
    new QueryCommand({
      ConsistentRead: true,
      ExpressionAttributeValues: {
        ":pk": key("ORG", organizationId),
        ":prefix": `${key("ORGANIZATION-GATE-LANE")}#`,
      },
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      Limit: ORGANIZATION_GATE_LANE_COUNT,
      TableName: controlTable,
    }),
  );
  const lanes = await Promise.all(
    (result.Items ?? []).map((item) => Effect.runPromise(decodePlatformRecord(item))),
  );
  return lanes.filter(isOrganizationGateLane);
}

const UNCHANGED_LANE = {
  ConditionExpression: "#data.#version = :previousVersion",
  ExpressionAttributeNames: { "#data": "data", "#version": "version" },
} as const;

function laneTransactItem(write: LaneWrite, controlTable: string): TransactItem {
  switch (write.kind) {
    case "absent":
      return {
        ConditionCheck: {
          ConditionExpression: "attribute_not_exists(pk)",
          Key: organizationGateLaneKey(write.organizationId, write.lane),
          TableName: controlTable,
        },
      };
    case "create":
      return {
        Put: {
          ConditionExpression: "attribute_not_exists(pk)",
          Item: write.record,
          TableName: controlTable,
        },
      };
    case "update":
      return {
        Put: {
          ...UNCHANGED_LANE,
          ExpressionAttributeValues: { ":previousVersion": write.previous.data.version },
          Item: write.record,
          TableName: controlTable,
        },
      };
    case "delete":
      return {
        Delete: {
          ...UNCHANGED_LANE,
          ExpressionAttributeValues: { ":previousVersion": write.previous.data.version },
          Key: { pk: write.previous.pk, sk: write.previous.sk },
          TableName: controlTable,
        },
      };
  }
}

/**
 * The raw transaction items that move an organization's lanes with gate source writes that
 * governance code sends in its own transactions. Each lane write is conditioned on the lane it read,
 * so a concurrent gate change cancels the transaction instead of being overwritten.
 */
export async function organizationGateLaneTransactItems(input: {
  readonly changes: readonly OrganizationGateChange[];
  readonly client: DynamoDBDocumentClient;
  readonly controlTable: string;
  readonly organizationId: Ulid;
}): Promise<readonly TransactItem[]> {
  const stored = await readOrganizationGateLanes(
    input.client,
    input.controlTable,
    input.organizationId,
  );
  return laneWrites(input.organizationId, input.changes, false, stored).map((write) =>
    laneTransactItem(write, input.controlTable),
  );
}

/**
 * The raw transaction items that make an organization's lanes equal to `state`, the state its gate
 * sources define: missing lanes are created and stale ones rewritten. When `state` is undefined
 * (the organization is gone) every lane is deleted or checked absent.
 */
export function organizationGateLaneRepairItems(input: {
  readonly at: string;
  readonly controlTable: string;
  readonly lanes: readonly OrganizationGateLane[];
  readonly organizationId: string;
  readonly state: OrganizationGateState | undefined;
}): readonly TransactItem[] {
  return laneWritesTo(input.organizationId, input.state, input.lanes, input.at).map((write) =>
    laneTransactItem(write, input.controlTable),
  );
}
