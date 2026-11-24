import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import type { ConsoleOperation, OperationAccess } from "../../access.ts";
import { membersQuery } from "../../data/membership-queries.ts";
import { useInstallCopy } from "../../edition.ts";
import {
  activeOwnerCount,
  memberActions,
  type ActionState,
  type MemberActions,
  type MemberActor,
} from "../../members/roles.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { ScrollCue } from "../observability/scroll-cue.tsx";
import { PublicId } from "../public-id.tsx";
import type { MembersDialog } from "./member-dialogs.tsx";
import { StatusBadge } from "@/components/status-badge";

const ROW_ACTIONS = [
  {
    kind: "change-role",
    label: "Change role",
    operation: "updateOrganizationMember",
    state: (actions: MemberActions) => actions.changeRole,
  },
  {
    kind: "remove",
    label: "Remove",
    operation: "removeOrganizationMember",
    state: (actions: MemberActions) => actions.remove,
  },
] as const satisfies readonly {
  readonly kind: "change-role" | "remove";
  readonly label: string;
  readonly operation: ConsoleOperation;
  readonly state: (actions: MemberActions) => ActionState;
}[];

export function MemberTable({
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
  const query = membersQuery(organizationId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(query);
  const members = data.pages.flatMap((page) => page.items);
  const activeOwners = activeOwnerCount(members, !hasNextPage);
  const offered = ROW_ACTIONS.filter((action) => access[action.operation]);
  const { offersBillingRole } = useInstallCopy();
  return (
    <div className="flex flex-col gap-4">
      <ScrollCue>
        <Table dense striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
              {offered.length > 0 ? (
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => {
              const actions = memberActions(member, actor, activeOwners, offersBillingRole);
              const refusals = new Set(
                offered.flatMap((action) => {
                  const state = action.state(actions);
                  return state.enabled ? [] : [state.reason];
                }),
              );
              return (
                <TableRow key={member.principalId}>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      {member.displayName ?? member.primaryEmail ?? (
                        <PublicId value={member.principalId} />
                      )}
                      {actions.self ? <Badge color="sky">You</Badge> : null}
                    </span>
                  </TableCell>
                  <TableCell>{member.primaryEmail ?? "—"}</TableCell>
                  <TableCell>{member.role}</TableCell>
                  <TableCell>
                    <StatusBadge status={member.status} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {member.joinedAt ? <Timestamp value={member.joinedAt} /> : "—"}
                  </TableCell>
                  {offered.length > 0 ? (
                    <TableCell>
                      <div className="flex flex-col items-end gap-1">
                        <div className="flex gap-2">
                          {offered.map((action) => (
                            <Button
                              disabled={!action.state(actions).enabled}
                              key={action.kind}
                              onClick={() => onDialog({ actions, kind: action.kind, member })}
                              variant="ghost"
                            >
                              {action.label}
                            </Button>
                          ))}
                        </div>
                        {[...refusals].map((reason) => (
                          <p
                            className="max-w-64 text-right text-xs/5 whitespace-normal text-muted-foreground"
                            key={reason}
                          >
                            {reason}
                          </p>
                        ))}
                      </div>
                    </TableCell>
                  ) : null}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </ScrollCue>
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
