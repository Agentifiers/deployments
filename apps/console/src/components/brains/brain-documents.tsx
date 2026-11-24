import { DocumentValidationIcon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { brainIndexHealthQuery } from "../../data/brain-queries.ts";
import { statusColor, statusLabel } from "../../status.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, Label } from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { Icon } from "../icon.tsx";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { StatusBadge } from "@/components/status-badge";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

export function BrainDocuments({
  brainId,
  brainPath,
  organizationId,
}: Readonly<{ brainId: string; brainPath: string; organizationId: string }>) {
  const healthQuery = brainIndexHealthQuery(organizationId, brainId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(healthQuery);
  const rows = data.pages.flatMap((page) => page.items);
  return (
    <div className="flex flex-col gap-8">
      <OpenById brainPath={brainPath} />
      <section className="flex flex-col gap-4">
        <Subheading>Index health</Subheading>
        {rows.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Icon icon={DocumentValidationIcon} />
              </EmptyMedia>
              <EmptyTitle>No documents indexed</EmptyTitle>
              <EmptyDescription>
                Index health lists a document version once the indexer has processed it. If
                documents you uploaded never appear here, search is not enabled for this
                organization: the documents are stored but not indexed until an operator enables
                Brain search.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table striped>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Components</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  href={`${brainPath}/documents/${row.documentId}`}
                  key={`${row.documentId}:${row.documentVersionId}`}
                  title={row.documentId}
                >
                  <TableCell>
                    <PublicId value={row.documentId} />
                  </TableCell>
                  <TableCell>
                    <PublicId value={row.documentVersionId} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={row.status} />
                    {row.lastError ? (
                      <Text className="mt-1 max-w-xs truncate" title={row.lastError}>
                        {row.lastError}
                      </Text>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {row.components.map((component) => (
                        <Badge
                          color={statusColor(component.status)}
                          key={component.kind}
                          title={component.error}
                        >
                          {component.kind} {statusLabel(component.status).toLowerCase()}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    <Timestamp value={row.synchronizedAt ?? row.updatedAt} />
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
          queryKey={healthQuery.queryKey}
        />
      </section>
    </div>
  );
}

const TARGETS = { document: "documents", entity: "entities" } as const;

function OpenById({ brainPath }: Readonly<{ brainPath: string }>) {
  const navigate = useNavigate();
  const [target, setTarget] = useState<keyof typeof TARGETS>("document");
  const [id, setId] = useState("");
  const valid = ULID.test(id.trim());
  const open = (event: FormEvent) => {
    event.preventDefault();
    if (valid) void navigate({ to: `${brainPath}/${TARGETS[target]}/${id.trim()}` });
  };
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={open}>
      <Field className="w-auto">
        <Label>Open</Label>
        <NativeSelect
          onChange={(event) => setTarget(event.target.value === "entity" ? "entity" : "document")}
          value={target}
        >
          <option value="document">Document</option>
          <option value="entity">Entity</option>
        </NativeSelect>
      </Field>
      <Field className="min-w-72 flex-1">
        <Label>ID</Label>
        <Input
          autoComplete="off"
          onChange={(event) => setId(event.target.value)}
          placeholder="01…"
          value={id}
        />
      </Field>
      <Button disabled={!valid} variant="outline" type="submit">
        Open
      </Button>
    </form>
  );
}
