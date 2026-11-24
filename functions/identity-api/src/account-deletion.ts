import type { OrganizationTie } from "@deployments-ai/db";
import { emailChangeHold, type EmailChangeHold, type EmailChangeView } from "./email-change.ts";

export interface OrganizationSummary {
  readonly organizationId: string;
  readonly organizationName: string;
}

export type ManagingOrganization = OrganizationSummary & {
  readonly managedBy: NonNullable<OrganizationTie["managedBy"]>;
};

/** What the account page can offer for the person's email address right now. */
export type EmailChangeAvailability =
  | { readonly kind: "available" }
  /** The organization's identity provider or SCIM directory owns the address. */
  | ({ readonly kind: "managed" } & ManagingOrganization)
  /** A recent change can still be reported, or was reported; see `EmailChangeHold`. */
  | ({ readonly kind: "held" } & EmailChangeHold)
  /** Nothing to re-authenticate with: the account signs in only through an identity provider. */
  | { readonly kind: "no-password" };

/** One reason the account cannot be deleted yet. */
export type DeletionBlocker =
  | ({ readonly kind: "sole-owner" } & OrganizationSummary)
  | ({ readonly kind: "managed" } & ManagingOrganization)
  | { readonly kind: "platform-administrator" }
  | { readonly kind: "no-password" }
  /** The previous address can still report a recent email change; deleting would void that. */
  | { readonly kind: "held"; readonly until: string };

export type AccountDeletionPlan =
  | { readonly kind: "allowed"; readonly leaves: readonly OrganizationSummary[] }
  | { readonly kind: "blocked"; readonly blockers: readonly DeletionBlocker[] };

export interface AccountFacts {
  readonly change: EmailChangeView;
  readonly at: Date;
  readonly hasPassword: boolean;
  readonly platformAdministrator: boolean;
  readonly ties: readonly OrganizationTie[];
}

const summary = (tie: OrganizationTie): OrganizationSummary => ({
  organizationId: tie.organizationId,
  organizationName: tie.organizationName,
});

function managingOrganization(ties: readonly OrganizationTie[]): ManagingOrganization | undefined {
  const tie = ties.find((candidate) => candidate.managedBy !== undefined);
  return tie?.managedBy ? { ...summary(tie), managedBy: tie.managedBy } : undefined;
}

/**
 * An organization's identity provider or SCIM directory keeps the address in step with its own
 * directory, so a change made here would be overwritten or break the link; the person asks that
 * organization's administrators instead. A recent or reported change holds new ones.
 */
export function emailChangeAvailability(facts: AccountFacts): EmailChangeAvailability {
  const managing = managingOrganization(facts.ties);
  if (managing) return { kind: "managed", ...managing };
  if (!facts.hasPassword) return { kind: "no-password" };
  const hold = emailChangeHold(facts.change, facts.at);
  return hold ? { kind: "held", ...hold } : { kind: "available" };
}

/**
 * An organization must always keep an owner, so being its only owner blocks deletion until the
 * person transfers ownership or erases it. Every other membership is removed with the account.
 * While the previous address can still report an email change, deletion waits: deleting would
 * destroy the change record and with it the report link, so whoever changed the address could
 * delete the account without its owner ever being able to undo it.
 */
export function planAccountDeletion(facts: AccountFacts): AccountDeletionPlan {
  const managing = managingOrganization(facts.ties);
  const reportable = emailChangeHold(facts.change, facts.at);
  const blockers: DeletionBlocker[] = [
    ...(reportable?.reason === "changed"
      ? [{ kind: "held" as const, until: reportable.until }]
      : []),
    ...(facts.platformAdministrator ? [{ kind: "platform-administrator" as const }] : []),
    ...(managing ? [{ kind: "managed" as const, ...managing }] : []),
    ...(facts.hasPassword ? [] : [{ kind: "no-password" as const }]),
    ...facts.ties
      .filter((tie) => tie.soleOwner)
      .map((tie) => ({ kind: "sole-owner" as const, ...summary(tie) })),
  ];
  return blockers.length > 0
    ? { blockers, kind: "blocked" }
    : { kind: "allowed", leaves: facts.ties.map(summary) };
}

const NAMES = new Intl.ListFormat("en", { type: "conjunction" });

/**
 * The sentence the API returns when a blocked deletion is attempted anyway. It names every
 * organization the person is the only owner of, since all of them must change before deletion.
 */
export function deletionBlockedMessage(blockers: readonly DeletionBlocker[]): string {
  const [first] = blockers;
  switch (first?.kind) {
    case undefined:
      return "Your account cannot be deleted right now.";
    case "sole-owner": {
      const owned = blockers.flatMap((blocker) =>
        blocker.kind === "sole-owner" ? [blocker.organizationName] : [],
      );
      return owned.length === 1
        ? `You are the only owner of ${first.organizationName}. Make someone else an owner or erase the organization first.`
        : `You are the only owner of ${NAMES.format(owned)}. Make someone else an owner or erase each of them first.`;
    }
    case "managed":
      return `${first.organizationName} manages your account through its identity provider. Ask its administrators to remove you.`;
    case "platform-administrator":
      return "Platform administrators cannot delete their own account.";
    case "no-password":
      return "Your account has no password to confirm the deletion with.";
    case "held":
      return "Your email changed recently. You can delete your account once the notice sent to your previous address expires.";
    default: {
      const unhandled: never = first;
      return unhandled;
    }
  }
}
