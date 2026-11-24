import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { systemOrganizationsQuery } from "../../data/console-queries.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text, TextLink } from "@/components/ui/text";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { StatusBadge } from "@/components/status-badge";

export function SystemOrganizations() {
  const pagesQuery = systemOrganizationsQuery();
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const organizations = data.pages.flatMap((page) => page.items);
  return (
    <div className="flex flex-col gap-4">
      {organizations.length === 0 ? (
        <Text>No organizations exist in this install yet.</Text>
      ) : (
        <Table dense striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Active members</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {organizations.map((organization) => (
              <TableRow key={organization.id}>
                <TableCell>
                  <TextLink href={`/system/organizations/${organization.id}`}>
                    {organization.name}
                  </TextLink>
                </TableCell>
                <TableCell>
                  <Code>{organization.slug}</Code>
                </TableCell>
                <TableCell>
                  <StatusBadge status={organization.status} />
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {organization.activeMemberCount}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={organization.updatedAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
    </div>
  );
}
