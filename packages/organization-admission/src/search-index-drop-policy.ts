import { haltMode, type HoldState, type StandingHold } from "@deployments-ai/db";
import { decideActivity } from "./activity-policy.ts";

export type SearchIndexDropRefusal =
  | "organization-active"
  | "no-operator-hold"
  | "organization-draining"
  | "evidence-preserved";

export type SearchIndexDropDecision =
  | { readonly kind: "authorized"; readonly hold: StandingHold }
  | { readonly kind: "refused"; readonly reason: SearchIndexDropRefusal };

/**
 * Whether an operator may drop the organization's own search indexes while it keeps its rows. An
 * operator hold that stops work must suspend it, and no hold may preserve evidence. The earliest
 * such hold authorizes the drop; a payment hold never does, because paying lifts it.
 */
export function decideSearchIndexDrop(standing: HoldState): SearchIndexDropDecision {
  if (standing.state === "active") return { kind: "refused", reason: "organization-active" };
  if (haltMode(standing.holds) === "drain") {
    return { kind: "refused", reason: "organization-draining" };
  }
  const hold = standing.holds.find(
    (candidate) => candidate.source === "operator" && haltMode([candidate]) === "stop",
  );
  if (!hold) return { kind: "refused", reason: "no-operator-hold" };
  if (decideActivity(standing, "api.erase").kind === "suspended") {
    return { kind: "refused", reason: "evidence-preserved" };
  }
  return { hold, kind: "authorized" };
}
