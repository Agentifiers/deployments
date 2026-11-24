import { Archive02Icon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { mintExportDownloadFn } from "../../data/governance-mutations.ts";
import { operationPagesQuery } from "../../data/governance-queries.ts";
import {
  DOWNLOAD_LINKS,
  EXPORT_SEGMENTS,
  isExportKind,
  OPERATION_LABELS,
  type ExportKind,
  type OperationView,
  type Phase,
} from "../../governance/operation-state.ts";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FreshLinkButton } from "../fresh-link.tsx";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { StatusBadge } from "@/components/status-badge";

export function PhaseBadge({ phase }: Readonly<{ phase: Phase }>) {
  return <StatusBadge status={phase.status} />;
}

export function ExportDownloads({
  kind,
  operation,
  organizationId,
}: Readonly<{ kind: ExportKind; operation: OperationView; organizationId: string }>) {
  const { artifact, phase } = operation;
  if (phase.status !== "completed" || artifact === undefined) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {DOWNLOAD_LINKS[artifact.kind].map(({ disposition, label, part }) => (
        <FreshLinkButton
          disposition={disposition}
          key={part}
          label={label}
          mint={() =>
            mintExportDownloadFn({
              data: { kind, operationId: operation.id, organizationId, part },
            })
          }
        />
      ))}
    </div>
  );
}

function OperationLink({
  operation,
  organizationId,
}: Readonly<{ operation: OperationView; organizationId: string }>) {
  const label = OPERATION_LABELS[operation.kind];
  if (operation.kind === "tenant-erasure") {
    return (
      <Link
        className="font-medium underline"
        params={{ operationId: operation.id, orgId: organizationId }}
        to="/erasures/$orgId/$operationId"
      >
        {label}
      </Link>
    );
  }
  if (!isExportKind(operation.kind)) return <span className="font-medium">{label}</span>;
  return (
    <Link
      className="font-medium underline"
      params={{
        kind: EXPORT_SEGMENTS[operation.kind],
        operationId: operation.id,
        orgId: organizationId,
      }}
      to="/o/$orgId/governance/$kind/$operationId"
    >
      {label}
    </Link>
  );
}

export function OperationHistory({ organizationId }: Readonly<{ organizationId: string }>) {
  const query = operationPagesQuery(organizationId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(query);
  const operations = data.pages.flatMap((page) => page.items);
  if (operations.length === 0) {
    return (
      <ListEmpty
        docs="/docs/capabilities/governance"
        icon={Archive02Icon}
        title="No governance operations"
      >
        Data exports, audit exports, and erasure requests appear here.
      </ListEmpty>
    );
  }
  return (
    <>
      <Table striped>
        <TableHeader>
          <TableRow>
            <TableHead>Operation</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Requested</TableHead>
            <TableHead>Files</TableHead>
            <TableHead>ID</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {operations.map((operation) => (
            <TableRow key={operation.id}>
              <TableCell>
                <OperationLink operation={operation} organizationId={organizationId} />
              </TableCell>
              <TableCell>
                <PhaseBadge phase={operation.phase} />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Timestamp value={operation.createdAt} />
              </TableCell>
              <TableCell>
                {isExportKind(operation.kind) ? (
                  <ExportDownloads
                    kind={operation.kind}
                    operation={operation}
                    organizationId={organizationId}
                  />
                ) : null}
              </TableCell>
              <TableCell>
                <PublicId value={operation.id} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={query.queryKey}
      />
    </>
  );
}
