import "@tanstack/react-start/server-only";
import type { InvitationView } from "../members/invitations.ts";
import type { MemberView } from "../members/roles.ts";
import { API_PAGE_LIMIT, fillPage, PAGE_SIZE, type Page } from "./list-pages.ts";
import { callRoute, collectPages, type RouteResponse } from "./platform-api.ts";

interface OrganizationScope {
  readonly organizationId: string;
}

export function memberView(
  member: RouteResponse<"listOrganizationMembers">["items"][number],
): MemberView {
  const { displayName, joinedAt, primaryEmail, principalId, removedAt, role, status } = member;
  return {
    principalId,
    role,
    status,
    ...(displayName === undefined ? {} : { displayName }),
    ...(joinedAt === undefined ? {} : { joinedAt }),
    ...(primaryEmail === undefined ? {} : { primaryEmail }),
    ...(removedAt === undefined ? {} : { removedAt }),
  };
}

export function invitationView(
  invitation: RouteResponse<"listOrganizationInvitations">["items"][number],
): InvitationView {
  const { createdAt, email, expiresAt, id, invitedByPrincipalId, role } = invitation;
  return { createdAt, email, expiresAt, id, invitedByPrincipalId, role };
}

export function loadMemberPage(
  accessToken: string,
  scope: OrganizationScope,
  cursor: string | undefined,
): Promise<Page<MemberView>> {
  return fillPage(
    async (pageCursor, limit) => {
      const page = await callRoute(
        "listOrganizationMembers",
        { query: { cursor: pageCursor, limit }, scope },
        accessToken,
      );
      return { items: page.items.map(memberView), nextCursor: page.nextCursor ?? undefined };
    },
    cursor,
    PAGE_SIZE,
  );
}

export async function loadMemberDirectory(
  accessToken: string,
  scope: OrganizationScope,
): Promise<readonly MemberView[]> {
  const members = await collectPages((cursor) =>
    callRoute(
      "listOrganizationMembers",
      { query: { cursor, limit: API_PAGE_LIMIT }, scope },
      accessToken,
    ),
  );
  return members.map(memberView);
}

/** Pages filter out non-pending invitations after reading, so a page can be short or empty. */
export function loadInvitationPage(
  accessToken: string,
  scope: OrganizationScope,
  cursor: string | undefined,
): Promise<Page<InvitationView>> {
  return fillPage(
    async (pageCursor, limit) => {
      const page = await callRoute(
        "listOrganizationInvitations",
        { query: { cursor: pageCursor, limit }, scope },
        accessToken,
      );
      return { items: page.items.map(invitationView), nextCursor: page.nextCursor ?? undefined };
    },
    cursor,
    PAGE_SIZE,
  );
}
