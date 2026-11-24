import type {
  CreateOrganizationInvitationRequest,
  UpdateOrganizationMemberRequest,
} from "@deployments-ai/api-contract/tenancy";
import { createServerFn } from "@tanstack/react-start";
import type { InvitationLink } from "../invitations/accept.ts";
import {
  acceptInvitation,
  createInvitation,
  removeMember,
  revokeInvitation,
  updateMember,
} from "../server/membership-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  fields,
  keyedInputAt,
  requireBody,
  requireIds,
  type KeyedInputAt,
} from "./server-input.ts";

type OrganizationKeyed = KeyedInputAt<"organization">;

export const updateMemberFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: OrganizationKeyed & {
        readonly body: typeof UpdateOrganizationMemberRequest.Encoded;
        readonly principalId: string;
      },
    ) => ({ ...keyedInputAt("organization", input, ["principalId"]), body: requireBody(input) }),
  )
  .handler(async ({ data }) => updateMember({ ...data, accessToken: await requireAccessToken() }));

export const removeMemberFn = createServerFn({ method: "POST" })
  .validator((input: OrganizationKeyed & { readonly principalId: string }) =>
    keyedInputAt("organization", input, ["principalId"]),
  )
  .handler(async ({ data }) => removeMember({ ...data, accessToken: await requireAccessToken() }));

export const createInvitationFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: OrganizationKeyed & {
        readonly body: typeof CreateOrganizationInvitationRequest.Encoded;
      },
    ) => ({ ...keyedInputAt("organization", input), body: requireBody(input) }),
  )
  .handler(async ({ data }) =>
    createInvitation({ ...data, accessToken: await requireAccessToken() }),
  );

export const revokeInvitationFn = createServerFn({ method: "POST" })
  .validator((input: OrganizationKeyed & { readonly invitationId: string }) =>
    keyedInputAt("organization", input, ["invitationId"]),
  )
  .handler(async ({ data }) =>
    revokeInvitation({ ...data, accessToken: await requireAccessToken() }),
  );

export const acceptInvitationFn = createServerFn({ method: "POST" })
  .validator((input: InvitationLink) => ({
    ...requireIds(input, ["invitationId"]),
    token: fields(input).token,
  }))
  .handler(async ({ data }) =>
    acceptInvitation({ ...data, accessToken: await requireAccessToken() }),
  );
