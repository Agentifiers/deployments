import { UserAdd01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "../components/icon.tsx";
import { InvitationTable } from "../components/members/invitation-table.tsx";
import { MembersDialogs, type MembersDialog } from "../components/members/member-dialogs.tsx";
import { MemberTable } from "../components/members/member-table.tsx";
import { SectionBoundary } from "../components/section-boundary.tsx";
import { organizationShellQuery } from "../data/console-queries.ts";
import { invitationsQuery, membersQuery } from "../data/membership-queries.ts";
import type { MemberActor } from "../members/roles.ts";
import { Button } from "@/components/ui/button";
import { Heading, Subheading } from "@/components/ui/heading";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";

export const Route = createFileRoute("/o/$orgId/members")({
  loader: async ({ context, params }) => {
    const { access } = await context.queryClient.ensureQueryData(
      organizationShellQuery(params.orgId),
    );
    if (access.listOrganizationMembers) {
      void context.queryClient.prefetchInfiniteQuery(membersQuery(params.orgId));
    }
    if (access.listOrganizationInvitations) {
      void context.queryClient.prefetchInfiniteQuery(invitationsQuery(params.orgId));
    }
  },
  component: Members,
});

function Members() {
  const { orgId } = Route.useParams();
  const {
    data: { access, authorization, principalId },
  } = useSuspenseQuery(organizationShellQuery(orgId));
  const [dialog, setDialog] = useState<MembersDialog>();
  const role = authorization.organizationRole;
  const actor: MemberActor = {
    platformAdministrator: authorization.platformRole === "administrator",
    principalId,
    ...(role === undefined ? {} : { role }),
  };
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>Members</Heading>
        {access.createOrganizationInvitation ? (
          <Button className="ml-auto" onClick={() => setDialog({ kind: "invite" })}>
            <Icon icon={UserAdd01Icon} />
            Invite
          </Button>
        ) : null}
      </div>
      {access.listOrganizationMembers ? (
        <SectionBoundary fallback={<Skeleton className="h-32 rounded-lg" />} resetKey={orgId}>
          <MemberTable access={access} actor={actor} onDialog={setDialog} organizationId={orgId} />
        </SectionBoundary>
      ) : (
        <Text>Your role or token scopes do not permit listing members (members:read).</Text>
      )}
      {access.listOrganizationInvitations ? (
        <section className="flex flex-col gap-4">
          <Subheading>Pending invitations</Subheading>
          <SectionBoundary fallback={<Skeleton className="h-32 rounded-lg" />} resetKey={orgId}>
            <InvitationTable
              access={access}
              actor={actor}
              onDialog={setDialog}
              organizationId={orgId}
            />
          </SectionBoundary>
        </section>
      ) : null}
      <MembersDialogs
        actor={actor}
        dialog={dialog}
        onClose={() => setDialog(undefined)}
        organizationId={orgId}
      />
    </div>
  );
}
