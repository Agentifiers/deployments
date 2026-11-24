import { useSuspenseQuery } from "@tanstack/react-query";
import { memberDirectoryQuery } from "../../data/membership-queries.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text, TextLink } from "@/components/ui/text";
import { StatusBadge } from "@/components/status-badge";

/** The organization's people, so an operator finds a principal by name or email. */
export function OrganizationMembers({ organizationId }: Readonly<{ organizationId: string }>) {
  const { data: members } = useSuspenseQuery(memberDirectoryQuery(organizationId));
  const current = members.filter((member) => member.status !== "removed");
  if (current.length === 0) return <Text>The organization has no members.</Text>;
  return (
    <Table dense striped>
      <TableHeader>
        <TableRow>
          <TableHead>Person</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Membership</TableHead>
          <TableHead>Principal ID</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {current.map((member) => (
          <TableRow key={member.principalId}>
            <TableCell>
              <div className="font-medium">{member.displayName ?? member.primaryEmail ?? "—"}</div>
              {member.displayName && member.primaryEmail ? (
                <div className="text-xs text-muted-foreground">{member.primaryEmail}</div>
              ) : null}
            </TableCell>
            <TableCell>{member.role}</TableCell>
            <TableCell>
              <StatusBadge status={member.status} />
            </TableCell>
            <TableCell>
              <Code>{member.principalId}</Code>
            </TableCell>
            <TableCell className="text-right">
              <TextLink href={`/system/people/${member.principalId}`}>Person</TextLink>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
