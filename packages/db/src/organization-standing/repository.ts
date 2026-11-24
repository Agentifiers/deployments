import { Schema } from "effect";
import type { DynamoDatabaseService, TransactionConditionCheck } from "../client-types.ts";
import { makeIdGenerator, type Ulid } from "../ids.ts";
import { key, Keys } from "../keys.ts";
import { PersistenceError } from "../persistence-types.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import {
  OrganizationStandingChangeRecord,
  OrganizationStandingRecord,
  type DataBoundaryProfile,
  type EntitlementGrant,
  type HoldKey,
  type HoldReason,
  type OrganizationDataBoundary,
  type StandingActor,
  type StandingGrants,
  type StandingSource,
} from "../records/organization-standing.ts";
import { makeSemanticEventRecord, transactWithSemanticEvents } from "../semantic-event-storage.ts";
import { isDatabaseWriteConflict } from "../transaction-conditions.ts";
import {
  effectiveStanding,
  holdState,
  type InstallDefaults,
  type EffectiveStanding,
  type HoldState,
} from "./effective-standing.ts";
import { standingEvents } from "./events.ts";
import { loadStanding } from "./stored-standing.ts";
import { transitionStanding, type StandingCommand, type StandingState } from "./transitions.ts";

const MAX_WRITE_ATTEMPTS = 5;

export type StandingOutcome =
  | { readonly kind: "changed"; readonly standing: EffectiveStanding }
  | { readonly kind: "unchanged"; readonly standing: EffectiveStanding }
  | {
      readonly kind: "refused";
      readonly owner: StandingSource;
      readonly standing: EffectiveStanding;
    };

interface StandingWrite {
  readonly organizationId: Ulid;
  /** The authenticated caller; its source is the only one whose entries it may change. */
  readonly actor: StandingActor;
}

export interface StandingHistoryPage {
  readonly items: readonly OrganizationStandingChangeRecord["data"][];
  /** Pass as `before` to read the next, older page. Absent on the last page. */
  readonly before?: number;
}

export interface OrganizationStandingRepository {
  readonly read: (
    organizationId: Ulid,
    options?: { readonly consistent?: boolean },
  ) => Promise<EffectiveStanding>;
  /**
   * The effective standing plus each source's stored grant and the stored data boundary, with who
   * set it and the operator's note, for install-wide callers.
   */
  readonly readWithGrants: (
    organizationId: Ulid,
    options?: { readonly consistent?: boolean },
  ) => Promise<{
    readonly dataBoundary: OrganizationDataBoundary | undefined;
    readonly grants: StandingGrants;
    readonly standing: EffectiveStanding;
  }>;
  readonly placeHold: (
    input: StandingWrite & {
      readonly key: HoldKey;
      readonly reason: HoldReason;
      readonly customerMessage: string;
      readonly operatorNote?: string;
    },
  ) => Promise<StandingOutcome>;
  readonly releaseHold: (
    input: StandingWrite & { readonly key: HoldKey; readonly releaseNote?: string },
  ) => Promise<StandingOutcome>;
  readonly setGrant: (
    input: StandingWrite & { readonly entitlements: EntitlementGrant },
  ) => Promise<StandingOutcome>;
  readonly clearGrant: (input: StandingWrite) => Promise<StandingOutcome>;
  /** Operators only; a service actor is refused with owner `operator`. */
  readonly setDataBoundary: (
    input: StandingWrite & {
      readonly profile: DataBoundaryProfile;
      readonly operatorNote: string;
    },
  ) => Promise<StandingOutcome>;
  readonly clearDataBoundary: (
    input: StandingWrite & { readonly operatorNote: string },
  ) => Promise<StandingOutcome>;
  /** Changes newest first, one per standing version. */
  readonly listHistory: (input: {
    readonly organizationId: Ulid;
    readonly before?: number;
    readonly limit: number;
  }) => Promise<StandingHistoryPage>;
}

/**
 * Fails the transaction that carries it while the organization holds at least one hold. A
 * missing standing record passes: it means no holds.
 */
export function organizationNotSuspendedCondition(organizationId: Ulid): TransactionConditionCheck {
  return {
    conditionExpression: "attribute_not_exists(#standingData.#standingSuspension)",
    expressionAttributeNames: {
      "#standingData": "data",
      "#standingSuspension": "suspension",
    },
    key: Keys.control.organizationStanding(organizationId),
    kind: "condition-check",
    table: "control",
  };
}

/**
 * Fails the transaction that carries it while the organization holds a hold that stops running
 * work: `abuse`, `policy`, or `manual`. A payment-only suspension passes, so admitted runs drain.
 * A missing standing record passes.
 */
export function organizationNotStoppedCondition(organizationId: Ulid): TransactionConditionCheck {
  return {
    conditionExpression:
      "attribute_not_exists(#standingData.#standingSuspension) OR #standingData.#standingSuspension.#standingHaltMode = :standingDrain",
    expressionAttributeNames: {
      "#standingData": "data",
      "#standingHaltMode": "haltMode",
      "#standingSuspension": "suspension",
    },
    expressionAttributeValues: { ":standingDrain": "drain" },
    key: Keys.control.organizationStanding(organizationId),
    kind: "condition-check",
    table: "control",
  };
}

export interface OrganizationHoldReader {
  readonly read: (
    organizationId: Ulid,
    options?: { readonly consistent?: boolean },
  ) => Promise<HoldState>;
}

/** Reads holds without entitlements, for decisions on holds alone: run admission and claims. */
export function makeOrganizationHoldReader(
  database: DynamoDatabaseService,
): OrganizationHoldReader {
  return {
    read: async (organizationId, options) =>
      holdState((await loadStanding(database, organizationId, options?.consistent ?? false))?.data),
  };
}

export function makeOrganizationStandingRepository(dependencies: {
  readonly database: DynamoDatabaseService;
  readonly installDefaults: InstallDefaults;
  readonly generateId?: () => Promise<Ulid>;
  readonly now?: () => Date;
}): OrganizationStandingRepository {
  const { database, installDefaults } = dependencies;
  const ids = makeIdGenerator();
  const generateId = dependencies.generateId ?? (async () => ids.generate());
  const now = dependencies.now ?? (() => new Date());

  const organizationNotFound = async (organizationId: Ulid) => {
    const organization = await database.getRecord(
      "control",
      { pk: key("ORG", organizationId), sk: key("ORG", organizationId) },
      true,
    );
    return organization?.itemType === "organization"
      ? undefined
      : new PersistenceError(
          "not-found",
          "organization_not_found",
          `Organization ${organizationId} does not exist.`,
        );
  };

  const apply = async (
    { actor, organizationId }: StandingWrite,
    command: StandingCommand,
  ): Promise<StandingOutcome> => {
    for (let attempt = 1; ; attempt += 1) {
      const previous = await loadStanding(database, organizationId, true);
      const at = now().toISOString();
      const version = (previous?.data.version ?? 0) + 1;
      const previousState: StandingState = {
        dataBoundary: previous?.data.dataBoundary,
        grants: previous?.data.grants ?? {},
        suspension: previous?.data.suspension,
      };
      const transition = transitionStanding({
        actor,
        at,
        command,
        nextVersion: version,
        organizationId,
        previous: previousState,
      });
      if (transition.kind !== "changed") {
        if (!previous) {
          const notFound = await organizationNotFound(organizationId);
          if (notFound) throw notFound;
        }
        const standing = effectiveStanding(previous?.data, installDefaults);
        return transition.kind === "refused"
          ? { kind: "refused", owner: transition.owner, standing }
          : { kind: "unchanged", standing };
      }

      const record = Schema.decodeUnknownSync(OrganizationStandingRecord)(
        withCanonicalRecordKeys({
          data: {
            createdAt: previous?.data.createdAt ?? at,
            ...(transition.next.dataBoundary ? { dataBoundary: transition.next.dataBoundary } : {}),
            grants: transition.next.grants,
            organizationId,
            ...(transition.next.suspension ? { suspension: transition.next.suspension } : {}),
            updatedAt: at,
            version,
          },
          itemType: "organization-standing" as const,
        }),
      );
      const history = Schema.decodeUnknownSync(OrganizationStandingChangeRecord)(
        withCanonicalRecordKeys({
          data: {
            actor,
            change: transition.change,
            occurredAt: at,
            organizationId,
            standingVersion: version,
            state: record.data.suspension ? "suspended" : "active",
          },
          itemType: "organization-standing-change" as const,
        }),
      );
      const events = await Promise.all(
        standingEvents({ actor, change: transition.change, flip: transition.flip }).map(
          async (event) =>
            makeSemanticEventRecord({
              actor:
                actor.kind === "operator"
                  ? { id: actor.principalId, type: "principal" }
                  : { type: "system" },
              aggregateId: event.aggregate === "standing" ? organizationId : event.suspensionId,
              aggregateType:
                event.aggregate === "standing"
                  ? "organization-standing"
                  : "organization-suspension",
              aggregateVersion: event.aggregate === "standing" ? version : event.version,
              eventId: await generateId(),
              eventType: event.eventType,
              occurredAt: at,
              organizationId,
              payload: event.payload,
            }),
        ),
      );
      try {
        await transactWithSemanticEvents(
          database,
          [
            { kind: "put", ...(previous ? { previousRecord: previous } : {}), record },
            { kind: "put", record: history },
          ],
          events,
        );
        return { kind: "changed", standing: effectiveStanding(record.data, installDefaults) };
      } catch (cause) {
        if (!isDatabaseWriteConflict(cause)) throw cause;
        const notFound = await organizationNotFound(organizationId);
        if (notFound) throw notFound;
        if (attempt >= MAX_WRITE_ATTEMPTS) {
          throw new PersistenceError(
            "conflict",
            "version_conflict",
            "The organization standing kept changing concurrently; retry the request.",
          );
        }
      }
    }
  };

  return {
    clearDataBoundary: ({ operatorNote, ...write }) =>
      apply(write, { kind: "clear-data-boundary", operatorNote }),
    clearGrant: (input) => apply(input, { kind: "clear-grant" }),
    listHistory: async ({ before, limit, organizationId }) => {
      if (before !== undefined && before <= 1) return { items: [] };
      const result = await database.queryRecords("control", {
        ConsistentRead: true,
        ExpressionAttributeValues: {
          ":lower": key("ORGANIZATION-STANDING-CHANGE", "1".padStart(16, "0")),
          ":pk": key("ORG", organizationId),
          ":upper": key(
            "ORGANIZATION-STANDING-CHANGE",
            String((before ?? Number.MAX_SAFE_INTEGER) - 1).padStart(16, "0"),
          ),
        },
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :lower AND :upper",
        Limit: limit,
        ScanIndexForward: false,
      });
      const items = result.items.flatMap((record) =>
        record.itemType === "organization-standing-change" ? [record.data] : [],
      );
      const oldest = items.at(-1)?.standingVersion;
      return {
        items,
        ...(oldest !== undefined && oldest > 1 ? { before: oldest } : {}),
      };
    },
    placeHold: ({ customerMessage, key: holdKey, operatorNote, reason, ...write }) =>
      apply(write, {
        customerMessage,
        key: holdKey,
        kind: "place-hold",
        ...(operatorNote === undefined ? {} : { operatorNote }),
        reason,
      }),
    read: async (organizationId, options) =>
      effectiveStanding(
        (await loadStanding(database, organizationId, options?.consistent ?? false))?.data,
        installDefaults,
      ),
    readWithGrants: async (organizationId, options) => {
      const stored = (await loadStanding(database, organizationId, options?.consistent ?? false))
        ?.data;
      return {
        dataBoundary: stored?.dataBoundary,
        grants: stored?.grants ?? {},
        standing: effectiveStanding(stored, installDefaults),
      };
    },
    releaseHold: ({ key: holdKey, releaseNote, ...write }) =>
      apply(write, {
        key: holdKey,
        kind: "release-hold",
        ...(releaseNote === undefined ? {} : { releaseNote }),
      }),
    setDataBoundary: ({ operatorNote, profile, ...write }) =>
      apply(write, { kind: "set-data-boundary", operatorNote, profile }),
    setGrant: ({ entitlements, ...write }) => apply(write, { entitlements, kind: "set-grant" }),
  };
}
