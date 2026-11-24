import type { OrganizationInvitationResponse } from "@deployments-ai/api-contract/tenancy";
import { invitationPath, type InvitationLink } from "../invitations/accept.ts";
import type { ShownOnce } from "../shown-once.ts";

export type InvitationView = Pick<
  typeof OrganizationInvitationResponse.Type,
  "createdAt" | "email" | "expiresAt" | "id" | "invitedByPrincipalId" | "role"
>;

/** The invitation with its accept link, which the console can show only once. */
export type IssuedInvitation = ShownOnce<InvitationView>;

export const INVITATION_EXPIRY_DAYS = [1, 7, 14, 30] as const;

export type InvitationExpiryDays = (typeof INVITATION_EXPIRY_DAYS)[number];

const DAY_MS = 86_400_000;
/** The API caps expiry at 30 days on its own clock; a minute of slack keeps "30 days" valid. */
const CLOCK_SLACK_MS = 60_000;

export function invitationExpiresAt(days: InvitationExpiryDays, now: Date): string {
  return new Date(now.getTime() + days * DAY_MS - CLOCK_SLACK_MS).toISOString();
}

/** The API accepts lowercase addresses only. */
export function normalizeInviteEmail(input: string): string {
  return input.trim().toLowerCase();
}

export function invitationUrl(origin: string, link: InvitationLink): string {
  return `${origin}${invitationPath(link)}`;
}
