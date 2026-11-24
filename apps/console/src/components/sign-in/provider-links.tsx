import type { IdentityProviderLinkResponse } from "@deployments-ai/api-contract";
import { useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { deleteIdentityProviderLinkFn } from "../../data/sign-in-mutations.ts";
import { identityProviderLinksQuery, invalidateSignIn } from "../../data/sign-in-queries.ts";
import { Button } from "@/components/ui/button";
import { Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import { ActionDialog, refreshOnConflict } from "../action-dialog.tsx";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";

export function ProviderLinks({
  canDelete,
  organizationId,
}: Readonly<{ canDelete: boolean; organizationId: string }>) {
  const queryClient = useQueryClient();
  const query = identityProviderLinksQuery(organizationId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(query);
  const links = data.pages.flatMap((page) => page.items);
  const [deleting, setDeleting] = useState<IdentityProviderLinkResponse>();
  const refresh = () => invalidateSignIn(queryClient, organizationId);
  return (
    <section className="flex flex-col gap-4">
      <Subheading>Linked accounts</Subheading>
      <Text>Each link ties an identity provider account to a platform member.</Text>
      {links.length === 0 ? (
        <Text>No linked accounts.</Text>
      ) : (
        <Table dense striped>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Subject</TableHead>
              <TableHead>Member</TableHead>
              <TableHead>Linked</TableHead>
              {canDelete ? (
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {links.map((link) => (
              <TableRow key={link.id}>
                <TableCell>{link.email ?? "—"}</TableCell>
                <TableCell>
                  <Code>{link.subject}</Code>
                </TableCell>
                <TableCell>
                  <PublicId value={link.principalId} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={link.createdAt} />
                </TableCell>
                {canDelete ? (
                  <TableCell className="text-right">
                    <Button onClick={() => setDeleting(link)} variant="ghost">
                      Delete
                    </Button>
                  </TableCell>
                ) : null}
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
        queryKey={query.queryKey}
      />
      {deleting ? (
        <ActionDialog
          confirmLabel="Delete link"
          description="Removes the tie between this identity provider account and the member."
          destructive
          onClose={() => setDeleting(undefined)}
          onSuccess={() => void refresh()}
          open
          run={(idempotencyKey) =>
            refreshOnConflict(
              deleteIdentityProviderLinkFn({
                data: { id: deleting.id, idempotencyKey, scope: { organizationId } },
              }),
              refresh,
            )
          }
          successMessage="Link deleted"
          title={`Delete the link for ${deleting.email ?? deleting.subject}?`}
        />
      ) : null}
    </section>
  );
}
