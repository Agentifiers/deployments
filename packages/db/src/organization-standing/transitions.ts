import { Schema } from "effect";
import { canonicalJsonValue } from "../canonical-json.ts";
import { deterministicUlid, type Ulid } from "../ids.ts";
import {
  haltMode,
  holdSlot,
  standingSource,
  StandingSource,
  type ActiveHold,
  type DataBoundaryProfile,
  type EntitlementGrant,
  type HoldKey,
  type HoldReason,
  type OrganizationDataBoundary,
  type OrganizationStanding,
  type OrganizationSuspension,
  type StandingActor,
  type StandingChange,
  type StandingGrants,
} from "../records/organization-standing.ts";

export type StandingCommand =
  | {
      readonly kind: "place-hold";
      readonly key: HoldKey;
      readonly reason: HoldReason;
      readonly customerMessage: string;
      readonly operatorNote?: string;
    }
  | { readonly kind: "release-hold"; readonly key: HoldKey; readonly releaseNote?: string }
  | { readonly kind: "set-grant"; readonly entitlements: EntitlementGrant }
  | { readonly kind: "clear-grant" }
  | {
      readonly kind: "set-data-boundary";
      readonly profile: DataBoundaryProfile;
      readonly operatorNote: string;
    }
  | { readonly kind: "clear-data-boundary"; readonly operatorNote: string };

/** `dataBoundary` is required so every transition names it and none drops it by omission. */
export type StandingState = Pick<OrganizationStanding, "grants" | "suspension"> & {
  readonly dataBoundary: OrganizationDataBoundary | undefined;
};

/** The hold set crossing empty, in either direction, and the suspension it opened or closed. */
export interface SuspensionFlip {
  readonly kind: "reinstated" | "suspended";
  readonly suspension: OrganizationSuspension;
}

export type StandingTransition =
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly owner: StandingSource }
  | {
      readonly kind: "changed";
      readonly next: StandingState;
      readonly change: StandingChange;
      readonly flip?: SuspensionFlip;
    };

const UNCHANGED = { kind: "unchanged" } as const;
const OPERATOR_SOURCE = Schema.decodeSync(StandingSource)("operator");

/** A suspension over a non-empty hold set, with the halt mode those holds derive. */
function suspended(
  holds: OrganizationSuspension["holds"],
  opened: Pick<OrganizationSuspension, "id" | "since">,
): OrganizationSuspension {
  return { haltMode: haltMode(Object.values(holds)), holds, id: opened.id, since: opened.since };
}

/**
 * The only producer of a new standing. Each source owns its own holds and grant, so a command
 * that would touch another source's entry is refused, and one that would change nothing is
 * `unchanged`.
 */
export function transitionStanding(input: {
  readonly organizationId: Ulid;
  readonly nextVersion: number;
  readonly previous: StandingState;
  readonly actor: StandingActor;
  readonly command: StandingCommand;
  readonly at: string;
}): StandingTransition {
  const { actor, command, previous } = input;
  const source = standingSource(actor);
  switch (command.kind) {
    case "place-hold": {
      const slot = holdSlot(source, command.key);
      if (previous.suspension?.holds[slot]) return UNCHANGED;
      const hold: ActiveHold = {
        customerMessage: command.customerMessage,
        key: command.key,
        ...(command.operatorNote === undefined ? {} : { operatorNote: command.operatorNote }),
        placedAt: input.at,
        placedBy: actor,
        reason: command.reason,
      };
      const suspension = suspended(
        { ...previous.suspension?.holds, [slot]: hold },
        previous.suspension ?? {
          id: deterministicUlid(
            `organization-suspension:${input.organizationId}:${input.nextVersion}`,
          ),
          since: input.at,
        },
      );
      return {
        change: { hold, kind: "hold-placed" },
        kind: "changed",
        next: { dataBoundary: previous.dataBoundary, grants: previous.grants, suspension },
        ...(previous.suspension ? {} : { flip: { kind: "suspended", suspension } }),
      };
    }
    case "release-hold": {
      const holds = previous.suspension?.holds ?? {};
      const slot = holdSlot(source, command.key);
      const hold = holds[slot];
      if (!previous.suspension || !hold) {
        const other = Object.values(holds).find((candidate) => candidate.key === command.key);
        return other ? { kind: "refused", owner: standingSource(other.placedBy) } : UNCHANGED;
      }
      const { [slot]: _released, ...remaining } = holds;
      const change: StandingChange = {
        hold,
        kind: "hold-released",
        ...(command.releaseNote === undefined ? {} : { releaseNote: command.releaseNote }),
      };
      return Object.keys(remaining).length > 0
        ? {
            change,
            kind: "changed",
            next: {
              dataBoundary: previous.dataBoundary,
              grants: previous.grants,
              suspension: suspended(remaining, previous.suspension),
            },
          }
        : {
            change,
            flip: { kind: "reinstated", suspension: previous.suspension },
            kind: "changed",
            next: { dataBoundary: previous.dataBoundary, grants: previous.grants },
          };
    }
    case "set-grant":
    case "clear-grant":
      return transitionGrant(previous, actor, command, input.at);
    case "set-data-boundary":
    case "clear-data-boundary":
      return transitionDataBoundary(previous, actor, command, input.at);
  }
}

function transitionDataBoundary(
  previous: StandingState,
  actor: StandingActor,
  command: Extract<StandingCommand, { readonly kind: "clear-data-boundary" | "set-data-boundary" }>,
  at: string,
): StandingTransition {
  if (actor.kind !== "operator") return { kind: "refused", owner: OPERATOR_SOURCE };
  const { grants } = previous;
  const suspension = previous.suspension ? { suspension: previous.suspension } : {};
  if (command.kind === "clear-data-boundary") {
    if (!previous.dataBoundary) return UNCHANGED;
    return {
      change: {
        kind: "data-boundary-cleared",
        operatorNote: command.operatorNote,
        profile: previous.dataBoundary.profile,
      },
      kind: "changed",
      next: { dataBoundary: undefined, grants, ...suspension },
    };
  }
  if (previous.dataBoundary?.profile === command.profile) return UNCHANGED;
  const dataBoundary: OrganizationDataBoundary = {
    operatorNote: command.operatorNote,
    profile: command.profile,
    setAt: at,
    setBy: actor,
  };
  return {
    change: { dataBoundary, kind: "data-boundary-set" },
    kind: "changed",
    next: { dataBoundary, grants, ...suspension },
  };
}

function transitionGrant(
  previous: StandingState,
  actor: StandingActor,
  command: Extract<StandingCommand, { readonly kind: "clear-grant" | "set-grant" }>,
  at: string,
): StandingTransition {
  const current = actor.kind === "operator" ? previous.grants.operator : previous.grants.service;
  if (
    current?.grantedBy.kind === "service" &&
    actor.kind === "service" &&
    current.grantedBy.service !== actor.service
  ) {
    return { kind: "refused", owner: standingSource(current.grantedBy) };
  }
  const { operator, service } = previous.grants;
  const withoutOwn: StandingGrants =
    actor.kind === "operator" ? (service ? { service } : {}) : operator ? { operator } : {};
  const suspension = previous.suspension ? { suspension: previous.suspension } : {};

  if (command.kind === "clear-grant") {
    if (!current) return UNCHANGED;
    return {
      change: { kind: "grant-cleared" },
      kind: "changed",
      next: { dataBoundary: previous.dataBoundary, grants: withoutOwn, ...suspension },
    };
  }
  if (
    current &&
    JSON.stringify(canonicalJsonValue(current.entitlements)) ===
      JSON.stringify(canonicalJsonValue(command.entitlements))
  ) {
    return UNCHANGED;
  }
  const grantFields = { entitlements: command.entitlements, grantedAt: at };
  return {
    change: { entitlements: command.entitlements, kind: "grant-set" },
    kind: "changed",
    next: {
      dataBoundary: previous.dataBoundary,
      grants:
        actor.kind === "operator"
          ? { ...withoutOwn, operator: { ...grantFields, grantedBy: actor } }
          : { ...withoutOwn, service: { ...grantFields, grantedBy: actor } },
      ...suspension,
    },
  };
}
