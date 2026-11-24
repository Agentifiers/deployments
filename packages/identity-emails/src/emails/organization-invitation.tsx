import { Button, Heading, Text } from "react-email";
import { expiryFormat, IdentityEmailLayout } from "./layout.tsx";

export interface OrganizationInvitationProps {
  readonly actionUrl: string;
  /** Invitation expiry as an ISO-8601 timestamp; rendered as a UTC date and time. */
  readonly expiresAt: string;
  readonly inviterName: string;
  readonly organizationName: string;
  readonly role: string;
}

export function OrganizationInvitation({
  actionUrl,
  expiresAt,
  inviterName,
  organizationName,
  role,
}: OrganizationInvitationProps) {
  return (
    <IdentityEmailLayout preview={`Join ${organizationName} on Deployments.ai`}>
      <Heading as="h1" className="mb-4 text-2xl font-semibold text-ink">
        Join {organizationName}
      </Heading>
      <Text className="text-base leading-6 text-ink">
        {inviterName} invited you to join {organizationName} on Deployments.ai as {role}.
      </Text>
      <Button
        href={actionUrl}
        className="box-border mt-4 rounded-md bg-ink px-5 py-3 text-center text-base font-semibold text-white no-underline"
      >
        Accept invitation
      </Button>
      <Text className="mt-6 text-sm leading-5 text-muted">
        This invitation expires {expiryFormat.format(new Date(expiresAt))} UTC. Sign in with this
        email address to accept it. If you weren’t expecting it, you can ignore this message.
      </Text>
    </IdentityEmailLayout>
  );
}

OrganizationInvitation.PreviewProps = {
  actionUrl:
    "https://app.us.deployments.ai/invitations/accept?invitation=01ARZ3NDEKTSV4RRFFQ69G5FAV&token=preview-token",
  expiresAt: "2026-08-01T12:00:00.000Z",
  inviterName: "Ada Lovelace",
  organizationName: "Acme",
  role: "member",
} satisfies OrganizationInvitationProps;

export default OrganizationInvitation;
