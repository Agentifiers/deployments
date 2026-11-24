import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { invalidateTenancy, organizationShellQuery } from "../../data/console-queries.ts";
import { removeMemberFn, updateMemberFn } from "../../data/membership-mutations.ts";
import { invalidateMembers } from "../../data/membership-queries.ts";
import type { InvitationView } from "../../members/invitations.ts";
import {
  isSelfDemotion,
  memberName,
  type MemberActions,
  type MemberActor,
  type MemberView,
  type OrganizationRole,
} from "../../members/roles.ts";
import { oneOf } from "../../observability/range.ts";
import { Field, Label } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionDialog, refreshOnConflict } from "../action-dialog.tsx";
import { InviteDialog, RevokeInvitationDialog } from "./invitation-dialogs.tsx";

export type MembersDialog =
  | {
      readonly kind: "change-role";
      readonly actions: MemberActions;
      readonly member: MemberView;
    }
  | { readonly kind: "remove"; readonly actions: MemberActions; readonly member: MemberView }
  | { readonly kind: "invite" }
  | { readonly kind: "revoke"; readonly invitation: InvitationView };

export function MembersDialogs({
  actor,
  dialog,
  onClose,
  organizationId,
}: Readonly<{
  actor: MemberActor;
  dialog: MembersDialog | undefined;
  onClose: () => void;
  organizationId: string;
}>) {
  switch (dialog?.kind) {
    case undefined:
      return null;
    case "change-role":
      return (
        <ChangeRoleDialog
          actions={dialog.actions}
          member={dialog.member}
          onClose={onClose}
          organizationId={organizationId}
        />
      );
    case "remove":
      return (
        <RemoveMemberDialog
          actions={dialog.actions}
          member={dialog.member}
          onClose={onClose}
          organizationId={organizationId}
        />
      );
    case "invite":
      return <InviteDialog actor={actor} onClose={onClose} organizationId={organizationId} />;
    case "revoke":
      return (
        <RevokeInvitationDialog
          invitation={dialog.invitation}
          onClose={onClose}
          organizationId={organizationId}
        />
      );
    default: {
      const unhandled: never = dialog;
      return unhandled;
    }
  }
}

function ChangeRoleDialog({
  actions,
  member,
  onClose,
  organizationId,
}: Readonly<{
  actions: MemberActions;
  member: MemberView;
  onClose: () => void;
  organizationId: string;
}>) {
  const queryClient = useQueryClient();
  const [role, setRole] = useState<OrganizationRole>(member.role);
  const selfDemotion = isSelfDemotion(actions, member.role, role);
  return (
    <ActionDialog
      confirmLabel="Change role"
      confirmation={selfDemotion ? role : undefined}
      description={
        selfDemotion
          ? `You lose your ${member.role} permissions as soon as this applies, and you cannot give them back to yourself.`
          : "The new role takes effect on the member's next request."
      }
      invalid={role === member.role}
      onClose={onClose}
      onSuccess={() => {
        void invalidateMembers(queryClient, organizationId);
        if (actions.self) {
          void queryClient.invalidateQueries({
            queryKey: organizationShellQuery(organizationId).queryKey,
          });
        }
      }}
      open
      run={(idempotencyKey) =>
        refreshOnConflict(
          updateMemberFn({
            data: {
              body: { role },
              idempotencyKey,
              principalId: member.principalId,
              scope: { organizationId },
            },
          }),
          () => invalidateMembers(queryClient, organizationId),
        )
      }
      successMessage={(updated) => `Role changed to ${updated.role}`}
      title={actions.self ? "Change your role" : `Change the role of ${memberName(member)}`}
    >
      <Field>
        <Label>Role</Label>
        <NativeSelect
          name="role"
          onChange={(event) => {
            const next = oneOf(actions.assignableRoles, event.target.value);
            if (next) setRole(next);
          }}
          value={role}
        >
          {actions.assignableRoles.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </ActionDialog>
  );
}

function RemoveMemberDialog({
  actions,
  member,
  onClose,
  organizationId,
}: Readonly<{
  actions: MemberActions;
  member: MemberView;
  onClose: () => void;
  organizationId: string;
}>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return (
    <ActionDialog
      confirmLabel={actions.self ? "Leave organization" : "Remove member"}
      confirmation={member.primaryEmail ?? member.principalId.slice(-8)}
      description={
        actions.self
          ? "You lose access to this organization at once. Only a new invitation lets you rejoin."
          : `${memberName(member)} loses access to this organization at once. Only a new invitation lets them rejoin.`
      }
      destructive
      onClose={onClose}
      onSuccess={() => {
        if (actions.self) {
          // Refetching this organization's shell after leaving it would render Not found here.
          void navigate({ to: "/" }).then(() => invalidateTenancy(queryClient));
        } else {
          void invalidateMembers(queryClient, organizationId);
        }
      }}
      open
      run={(idempotencyKey) =>
        refreshOnConflict(
          removeMemberFn({
            data: { idempotencyKey, principalId: member.principalId, scope: { organizationId } },
          }),
          () => invalidateMembers(queryClient, organizationId),
        )
      }
      successMessage={actions.self ? "You left the organization" : "Member removed"}
      title={actions.self ? "Leave this organization?" : `Remove ${memberName(member)}?`}
    />
  );
}
