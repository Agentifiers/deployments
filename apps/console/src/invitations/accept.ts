import { PUBLIC_ID_PATTERN } from "@deployments-ai/api-contract/primitives";
import { InvitationToken } from "@deployments-ai/api-contract/tenancy";
import { Schema } from "effect";

/** The accept page's query string as the router hands it over; nothing is trusted yet. */
export interface InvitationSearch {
  readonly invitation?: string;
  readonly token?: string;
}

/** An emailed invitation link that can be sent to the API. */
export interface InvitationLink {
  readonly invitationId: string;
  readonly token: string;
}

/**
 * Where the accept page stands. `ready` waits for the person's explicit confirmation; accepting
 * either leaves the page or lands in one failure phase. `rejected` applied nothing and `uncertain`
 * may have applied (accept is not idempotent), so both offer a retry; the rest are terminal.
 */
export type AcceptPhase =
  | { readonly kind: "malformed" }
  | { readonly kind: "ready" }
  | { readonly kind: "wrong-account" }
  | { readonly kind: "already-member" }
  | { readonly kind: "expired" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "invalid" }
  | { readonly kind: "rejected"; readonly code?: string }
  | { readonly kind: "uncertain" };

type TerminalKind = "already-member" | "expired" | "invalid" | "unavailable" | "wrong-account";

const PHASE_BY_CODE: Readonly<Record<string, TerminalKind>> = {
  invalid_invitation_token: "invalid",
  invitation_email_mismatch: "wrong-account",
  invitation_expired: "expired",
  invitation_not_found: "invalid",
  invitation_unavailable: "unavailable",
  member_exists: "already-member",
};

const INVALID_REQUEST_STATUSES: ReadonlySet<number> = new Set([400, 404, 422]);

const isInvitationToken = Schema.is(InvitationToken);

export function invitationSearch(raw: Readonly<Record<string, unknown>>): InvitationSearch {
  const { invitation, token } = raw;
  return {
    ...(typeof invitation === "string" ? { invitation } : {}),
    ...(typeof token === "string" ? { token } : {}),
  };
}

export function invitationLink(search: InvitationSearch): InvitationLink | undefined {
  const { invitation, token } = search;
  if (invitation === undefined || !PUBLIC_ID_PATTERN.test(invitation)) return undefined;
  if (!isInvitationToken(token)) return undefined;
  return { invitationId: invitation, token };
}

export function invitationPath(link: InvitationLink): string {
  return `/invitations/accept?${new URLSearchParams({ invitation: link.invitationId, token: link.token })}`;
}

/** The phase a failed accept lands in; `undefined` means no problem response arrived. */
export function acceptFailurePhase(
  problem: { readonly code?: string; readonly status: number } | undefined,
): AcceptPhase {
  if (problem === undefined || problem.status >= 500) return { kind: "uncertain" };
  const known = problem.code === undefined ? undefined : PHASE_BY_CODE[problem.code];
  if (known !== undefined) return { kind: known };
  if (INVALID_REQUEST_STATUSES.has(problem.status)) return { kind: "invalid" };
  return problem.code === undefined
    ? { kind: "rejected" }
    : { code: problem.code, kind: "rejected" };
}

interface OrganizationRef {
  readonly id: string;
  readonly name: string;
}

/** Whether `organizationsAfter` can prove an earlier accept committed although its answer was lost. */
export type AcceptRecovery =
  | { readonly kind: "joined"; readonly organization: OrganizationRef }
  | { readonly kind: "unconfirmed" };

/**
 * Whether a failed accept may have joined anyway: its own answer was lost, or a retry after a lost
 * answer found the invitation used or the membership present. Without a lost answer those two
 * phases are the truth, and an organization that appeared meanwhile came from somewhere else.
 */
export function mayHaveJoined(
  phase: AcceptPhase,
  { earlierAnswerLost }: { readonly earlierAnswerLost: boolean },
): boolean {
  if (phase.kind === "uncertain") return true;
  return earlierAnswerLost && (phase.kind === "unavailable" || phase.kind === "already-member");
}

/**
 * Membership reads are live, so exactly one organization that was not in the list before the
 * first attempt is the one the invitation joined; none or several prove nothing.
 */
export function acceptRecovery(
  before: readonly OrganizationRef[],
  after: readonly OrganizationRef[],
): AcceptRecovery {
  const known = new Set(before.map((organization) => organization.id));
  const joined = after.filter((organization) => !known.has(organization.id));
  return joined.length === 1 && joined[0] !== undefined
    ? { kind: "joined", organization: joined[0] }
    : { kind: "unconfirmed" };
}
