import type { Ulid } from "../ids.ts";
import type { DynamoValue } from "../record-schema.ts";
import {
  standingSource,
  type StandingActor,
  type StandingChange,
  type StandingSource,
} from "../records/organization-standing.ts";
import type { SuspensionFlip } from "./transitions.ts";

/**
 * A semantic event before ids are assigned. Every standing version appends one event to the
 * `organization-standing` aggregate; a suspension is its own aggregate, opened by
 * `organization.suspended` (version 1) and closed by `organization.reinstated` (version 2), because
 * one transaction may append only one event per aggregate.
 */
export type StandingEvent = {
  readonly eventType: string;
  readonly payload: Readonly<Record<string, DynamoValue>>;
} & (
  | { readonly aggregate: "standing" }
  | { readonly aggregate: "suspension"; readonly suspensionId: Ulid; readonly version: 1 | 2 }
);

/** The one event each standing version appends to the `organization-standing` aggregate. */
function standingVersionEvent(
  change: StandingChange,
  source: StandingSource,
): Pick<StandingEvent, "eventType" | "payload"> {
  switch (change.kind) {
    case "hold-placed":
      return {
        eventType: "organization.hold-placed",
        payload: {
          customerMessage: change.hold.customerMessage,
          key: change.hold.key,
          reason: change.hold.reason,
          source,
        },
      };
    case "hold-released":
      return {
        eventType: "organization.hold-released",
        payload: { key: change.hold.key, reason: change.hold.reason, source },
      };
    case "grant-set":
    case "grant-cleared":
      return {
        eventType: "organization.entitlements-updated",
        payload: { granted: change.kind === "grant-set", source },
      };
    case "data-boundary-set":
      return {
        eventType: "organization.data-boundary-set",
        payload: { profile: change.dataBoundary.profile, source },
      };
    case "data-boundary-cleared":
      return {
        eventType: "organization.data-boundary-cleared",
        payload: { profile: change.profile, source },
      };
  }
}

export function standingEvents(input: {
  readonly actor: StandingActor;
  readonly change: StandingChange;
  readonly flip: SuspensionFlip | undefined;
}): readonly StandingEvent[] {
  const { change, flip } = input;
  const source = standingSource(input.actor);
  const primary: StandingEvent = { aggregate: "standing", ...standingVersionEvent(change, source) };
  if (!flip) return [primary];
  const { suspension } = flip;
  return [
    primary,
    flip.kind === "suspended"
      ? {
          aggregate: "suspension",
          eventType: "organization.suspended",
          payload: {
            reasons: [...new Set(Object.values(suspension.holds).map((hold) => hold.reason))],
            since: suspension.since,
          },
          suspensionId: suspension.id,
          version: 1,
        }
      : {
          aggregate: "suspension",
          eventType: "organization.reinstated",
          payload: { since: suspension.since },
          suspensionId: suspension.id,
          version: 2,
        },
  ];
}
