import { CheckmarkBadge01Icon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { approvalPagesQuery } from "../../data/runtime-queries.ts";
import { APPROVAL_TABS, type ApprovalFilters, type ApprovalTab } from "../../runs/filters.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { Code, TextLink } from "@/components/ui/text";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import type { RouteTab } from "../route-tabs.tsx";
import { StatusBadge } from "@/components/status-badge";

const TAB_LABELS: Readonly<Record<ApprovalTab, string>> = {
  all: "All",
  approved: "Approved",
  expired: "Expired",
  pending: "Pending",
  rejected: "Rejected",
};

const EMPTY_TITLES: Readonly<Record<ApprovalTab, string>> = {
  all: "No approvals",
  approved: "No approved requests",
  expired: "No expired requests",
  pending: "Nothing waits for a decision",
  rejected: "No rejected requests",
};

export function approvalTabs(scope: EnvironmentScope, filters: ApprovalFilters): RouteTab[] {
  const basePath = `${environmentPath(scope)}/approvals`;
  const current = filters.status ?? "pending";
  return APPROVAL_TABS.map((tab) => ({
    current: tab === current,
    href: tab === "pending" ? basePath : `${basePath}?status=${tab}`,
    label: TAB_LABELS[tab],
  }));
}

/**
 * Where a call the data boundary holds for approval would send data. Each destination is shown in
 * full and wraps, since a path or query can carry the data the approver is judging.
 */
export function ApprovalDestinations({
  destinations,
}: Readonly<{ destinations: readonly string[] }>) {
  if (destinations.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-1">
      <span className="text-xs/5 font-medium text-muted-foreground">
        Outside the egress allowlist
      </span>
      <ul aria-label="Destinations" className="flex flex-col gap-1">
        {destinations.map((destination) => (
          <li className="font-mono text-xs/5 break-all whitespace-normal" key={destination}>
            {destination}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ApprovalInbox({
  filters,
  scope,
}: Readonly<{ filters: ApprovalFilters; scope: EnvironmentScope }>) {
  const pagesQuery = approvalPagesQuery(scope, filters);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const approvals = data.pages.flatMap((page) => page.items);
  const tab = filters.status ?? "pending";
  const basePath = environmentPath(scope);

  return (
    <div className="flex flex-col gap-4">
      {approvals.length === 0 ? (
        <ListEmpty
          docs="/docs/capabilities/approvals-and-client-tools"
          icon={CheckmarkBadge01Icon}
          title={EMPTY_TITLES[tab]}
        >
          {tab === "pending"
            ? "Runs that wait for a human decision on a tool call appear here."
            : null}
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead>Input</TableHead>
              <TableHead>Effect</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Run</TableHead>
              <TableHead>Requested</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Resolved</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {approvals.map((approval) => (
              <TableRow key={approval.id}>
                <TableCell>
                  {approval.request.toolName ? <Code>{approval.request.toolName}</Code> : "—"}
                </TableCell>
                <TableCell className="max-w-96">
                  <div className="truncate" title={approval.request.inputSummary}>
                    {approval.request.inputSummary ?? "—"}
                  </div>
                  <ApprovalDestinations destinations={approval.request.destinations} />
                </TableCell>
                <TableCell>{approval.request.effect ?? "—"}</TableCell>
                <TableCell>
                  <StatusBadge status={approval.status} />
                </TableCell>
                <TableCell>
                  <TextLink
                    href={`${basePath}/runs/${approval.runId}`}
                    title={`Run ${approval.runId}`}
                  >
                    <Code>…{approval.runId.slice(-8)}</Code>
                  </TextLink>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={approval.createdAt} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {approval.expiresAt ? <Timestamp value={approval.expiresAt} /> : "—"}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {approval.resolvedAt ? (
                    <>
                      <Timestamp value={approval.resolvedAt} />
                      {approval.resolvedByPrincipalId ? (
                        <>
                          {" "}
                          by <PublicId value={approval.resolvedByPrincipalId} />
                        </>
                      ) : null}
                    </>
                  ) : (
                    "—"
                  )}
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
