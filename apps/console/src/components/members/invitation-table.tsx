import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import type { OperationAccess } from "../../access.ts";
import { invitationsQuery } from "../../data/membership-queries.ts";
import { invitationActions, type MemberActor } from "../../members/roles.ts";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import type { MembersDialog } from "./member-dialogs.tsx";

export function InvitationTable({
  access,
  actor,
  onDialog,
  organizationId,
}: Readonly<{
  access: OperationAccess;
  actor: MemberActor;
  onDialog: (dialog: MembersDialog) => void;
  organizationId: string;
}>) {
  const query = invitationsQuery(organizationId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(query);
  const invitations = data.pages.flatMap((page) => page.items);
  return (
    <div className="flex flex-col gap-4">
      {invitations.length === 0 ? (
        <Text>No pending invitations.</Text>
      ) : (
        <Table dense striped>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Invited by</TableHead>
              <TableHead>Created</TableHead>
              {access.revokeOrganizationInvitation ? (
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {invitations.map((invitation) => {
              const { revoke } = invitationActions(invitation, actor);
              return (
                <TableRow key={invitation.id}>
                  <TableCell>{invitation.email}</TableCell>
                  <TableCell>{invitation.role}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Timestamp value={invitation.expiresAt} />
                  </TableCell>
                  <TableCell>
                    <PublicId value={invitation.invitedByPrincipalId} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Timestamp value={invitation.createdAt} />
                  </TableCell>
                  {access.revokeOrganizationInvitation ? (
                    <TableCell>
                      <div className="flex flex-col items-end gap-1">
                        <Button
                          disabled={!revoke.enabled}
                          onClick={() => onDialog({ invitation, kind: "revoke" })}
                          variant="ghost"
                        >
                          Revoke
                        </Button>
                        {revoke.enabled ? null : (
                          <p className="max-w-64 text-right text-xs/5 whitespace-normal text-muted-foreground">
                            {revoke.reason}
                          </p>
                        )}
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={query.queryKey}
      />
    </div>
  );
}
