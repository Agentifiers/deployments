import { EmailAddress } from "@deployments-ai/api-contract/primitives";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { useState } from "react";
import { createInvitationFn, revokeInvitationFn } from "../../data/membership-mutations.ts";
import { invalidateInvitations, membersQuery } from "../../data/membership-queries.ts";
import { PlatformApiError } from "../../errors.ts";
import {
  INVITATION_EXPIRY_DAYS,
  invitationExpiresAt,
  invitationUrl,
  normalizeInviteEmail,
  type InvitationExpiryDays,
  type InvitationView,
} from "../../members/invitations.ts";
import { useInstallCopy } from "../../edition.ts";
import { invitableRoles, type MemberActor, type OrganizationRole } from "../../members/roles.ts";
import { oneOf } from "../../observability/range.ts";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Description, ErrorMessage, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { ActionDialog } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { SecretActionDialog } from "../secret-action-dialog.tsx";

const isEmailAddress = Schema.is(EmailAddress);

export function InviteDialog({
  actor,
  onClose,
  organizationId,
}: Readonly<{ actor: MemberActor; onClose: () => void; organizationId: string }>) {
  const queryClient = useQueryClient();
  const roles = invitableRoles(actor, useInstallCopy().offersBillingRole);
  // The API fingerprints the body with the idempotency key, so a retry must send the same expiry.
  const [openedAt] = useState(() => new Date());
  const [emailInput, setEmailInput] = useState("");
  const [role, setRole] = useState<OrganizationRole>("member");
  const [days, setDays] = useState<InvitationExpiryDays>(7);
  const email = normalizeInviteEmail(emailInput);
  const expiresAt = invitationExpiresAt(days, openedAt);
  const alreadyMember = queryClient
    .getQueryData(membersQuery(organizationId).queryKey)
    ?.pages.some((page) =>
      page.items.some((member) => member.status === "active" && member.primaryEmail === email),
    );
  return (
    <SecretActionDialog<InvitationView>
      confirmLabel="Create invitation"
      description="The link lets the person who signs in with this email address join the organization with the role you choose."
      invalid={!isEmailAddress(email)}
      onClose={onClose}
      onIssued={() => void invalidateInvitations(queryClient, organizationId)}
      onStored={() => undefined}
      open
      run={async (idempotencyKey) => {
        const { secret, view } = await createInvitationFn({
          data: { body: { email, expiresAt, role }, idempotencyKey, scope: { organizationId } },
        });
        return {
          secret: invitationUrl(window.location.origin, { invitationId: view.id, token: secret }),
          view,
        };
      }}
      secretDescription={(view) =>
        `${view.email} signs in with that address and opens this link to join as ${view.role}. If this install sends invitation email, they may also receive it there.`
      }
      secretLabel="invitation link"
      successMessage="Invitation created"
      title="Invite a member"
    >
      <Field>
        <Label>Email</Label>
        <Input
          aria-invalid={emailInput !== "" && !isEmailAddress(email)}
          autoComplete="off"
          onChange={(event) => setEmailInput(event.target.value)}
          type="email"
          value={emailInput}
        />
        {emailInput !== "" && !isEmailAddress(email) ? (
          <ErrorMessage>Enter an email address, such as name@example.com.</ErrorMessage>
        ) : null}
      </Field>
      {alreadyMember ? (
        <Callout>
          <Icon icon={Alert02Icon} />
          <CalloutTitle>Already a member</CalloutTitle>
          <CalloutDescription>
            {email} is an active member. The invitation can be created, but accepting it will fail.
          </CalloutDescription>
        </Callout>
      ) : null}
      <Field>
        <Label>Role</Label>
        <NativeSelect
          name="role"
          onChange={(event) => {
            const next = oneOf(roles, event.target.value);
            if (next) setRole(next);
          }}
          value={role}
        >
          {roles.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <Label>Expires</Label>
        <Description>
          The link stops working at <Timestamp value={expiresAt} />.
        </Description>
        <NativeSelect
          name="expiry"
          onChange={(event) => {
            const next = INVITATION_EXPIRY_DAYS.find(
              (option) => `${option}` === event.target.value,
            );
            if (next) setDays(next);
          }}
          value={days}
        >
          {INVITATION_EXPIRY_DAYS.map((option) => (
            <option key={option} value={option}>
              {option === 1 ? "1 day" : `${option} days`}
            </option>
          ))}
        </NativeSelect>
      </Field>
    </SecretActionDialog>
  );
}

export function RevokeInvitationDialog({
  invitation,
  onClose,
  organizationId,
}: Readonly<{ invitation: InvitationView; onClose: () => void; organizationId: string }>) {
  const queryClient = useQueryClient();
  return (
    <ActionDialog
      confirmLabel="Revoke invitation"
      confirmation={invitation.email}
      description="The invitation link stops working at once. Revoking cannot be undone; invite the address again to send a new link."
      destructive
      onClose={onClose}
      onSuccess={() => void invalidateInvitations(queryClient, organizationId)}
      open
      run={async (idempotencyKey) => {
        try {
          return await revokeInvitationFn({
            data: { idempotencyKey, invitationId: invitation.id, scope: { organizationId } },
          });
        } catch (error) {
          if (error instanceof PlatformApiError && error.problem.status === 409) {
            void invalidateInvitations(queryClient, organizationId);
          }
          throw error;
        }
      }}
      successMessage="Invitation revoked"
      title={`Revoke the invitation for ${invitation.email}?`}
    />
  );
}
