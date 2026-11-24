import "@tanstack/react-start/server-only";
import type { InvitationView } from "../members/invitations.ts";
import type { MemberView } from "../members/roles.ts";
import type { ShownOnce } from "../shown-once.ts";
import { invitationView, memberView } from "./membership-data.ts";
import { callRoute } from "./platform-api.ts";
import { decodeRequestBody } from "./request-body.ts";

export interface OrganizationMutation {
  readonly accessToken: string;
  readonly idempotencyKey: string;
  readonly scope: { readonly organizationId: string };
}

export async function updateMember({
  accessToken,
  body,
  idempotencyKey,
  principalId,
  scope,
}: OrganizationMutation & {
  readonly body: unknown;
  readonly principalId: string;
}): Promise<MemberView> {
  return memberView(
    await callRoute(
      "updateOrganizationMember",
      {
        body: decodeRequestBody(
          "updateOrganizationMember",
          "UpdateOrganizationMemberRequest",
          body,
        ),
        idempotencyKey,
        path: { id: principalId },
        scope,
      },
      accessToken,
    ),
  );
}

export async function removeMember({
  accessToken,
  idempotencyKey,
  principalId,
  scope,
}: OrganizationMutation & { readonly principalId: string }): Promise<MemberView> {
  return memberView(
    await callRoute(
      "removeOrganizationMember",
      { idempotencyKey, path: { id: principalId }, scope },
      accessToken,
    ),
  );
}

/** The token comes back only in this response; the browser turns it into the accept link. */
export async function createInvitation({
  accessToken,
  body,
  idempotencyKey,
  scope,
}: OrganizationMutation & { readonly body: unknown }): Promise<ShownOnce<InvitationView>> {
  const issued = await callRoute(
    "createOrganizationInvitation",
    {
      body: decodeRequestBody(
        "createOrganizationInvitation",
        "CreateOrganizationInvitationRequest",
        body,
      ),
      idempotencyKey,
      scope,
    },
    accessToken,
  );
  return { secret: issued.token, view: invitationView(issued) };
}

export async function revokeInvitation({
  accessToken,
  idempotencyKey,
  invitationId,
  scope,
}: OrganizationMutation & { readonly invitationId: string }): Promise<InvitationView> {
  return invitationView(
    await callRoute(
      "revokeOrganizationInvitation",
      { idempotencyKey, path: { id: invitationId }, scope },
      accessToken,
    ),
  );
}

/**
 * Accept sends no tenant headers (the caller is not a member yet) and no idempotency key (the
 * route has none), so a lost response must not be retried blindly.
 */
export async function acceptInvitation({
  accessToken,
  invitationId,
  token,
}: {
  readonly accessToken: string;
  readonly invitationId: string;
  readonly token: unknown;
}): Promise<{ readonly organizationId: string }> {
  const member = await callRoute(
    "acceptOrganizationInvitation",
    {
      body: decodeRequestBody(
        "acceptOrganizationInvitation",
        "AcceptOrganizationInvitationRequest",
        { token },
      ),
      path: { id: invitationId },
    },
    accessToken,
  );
  return { organizationId: member.organizationId };
}
