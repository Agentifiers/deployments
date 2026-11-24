import { File01Icon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { invalidateRuntime } from "../../data/runtime-queries.ts";
import { createArtifactLinkFn, updateArtifactRetentionFn } from "../../data/thread-mutations.ts";
import { artifactPagesQuery, artifactQuery } from "../../data/thread-queries.ts";
import { formatByteSize } from "../../runs/views.ts";
import type { EnvironmentScope } from "../../scope.ts";
import type { ArtifactOwner } from "../../server/artifact-data.ts";
import { Button } from "@/components/ui/button";
import { Description, Field, Label } from "@/components/ui/field";
import { Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { Code, Text } from "@/components/ui/text";
import { ActionDialog, refreshOnConflict } from "../action-dialog.tsx";
import { beforeToday, DatePicker } from "../date-picker.tsx";
import { FreshLinkButton } from "../fresh-link.tsx";
import { Icon } from "../icon.tsx";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { StatusBadge } from "@/components/status-badge";

/** Files a run produced or a thread's runs attached, with download and retention. */
export function ArtifactList({
  owner,
  scope,
}: Readonly<{ owner: ArtifactOwner; scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const pagesQuery = artifactPagesQuery(scope, owner);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const [retaining, setRetaining] = useState<string>();
  const artifacts = data.pages.flatMap((page) => page.items);
  return (
    <section className="flex flex-col gap-4">
      <Subheading>Files</Subheading>
      {artifacts.length === 0 ? (
        <Text className="flex items-center gap-2">
          <Icon className="size-4" icon={File01Icon} />
          {owner.kind === "run"
            ? "This run produced no files."
            : "No run in this thread produced or attached files."}
        </Text>
      ) : (
        <Table dense striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Kept until</TableHead>
              <TableHead>Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {artifacts.map((artifact) => (
              <TableRow key={artifact.artifactId}>
                <TableCell className="max-w-64 truncate" title={artifact.fileName ?? artifact.name}>
                  {artifact.fileName ?? artifact.name}
                </TableCell>
                <TableCell>
                  <Code>{artifact.contentType}</Code>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatByteSize(artifact.byteSize)}
                </TableCell>
                <TableCell>
                  <StatusBadge status={artifact.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={artifact.createdAt} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {artifact.retentionExpiresAt ? (
                    <Timestamp value={artifact.retentionExpiresAt} />
                  ) : (
                    "With its thread"
                  )}
                </TableCell>
                <TableCell className="flex gap-2 whitespace-nowrap">
                  {shell.access.createArtifactAccessUrl ? (
                    <FreshLinkButton
                      disabled={artifact.status !== "available"}
                      disposition="download"
                      label="Download"
                      mint={() =>
                        createArtifactLinkFn({ data: { artifactId: artifact.artifactId, scope } })
                      }
                    />
                  ) : null}
                  {shell.access.updateArtifactRetention && artifact.status !== "deleted" ? (
                    <Button onClick={() => setRetaining(artifact.artifactId)} variant="ghost">
                      Retention
                    </Button>
                  ) : null}
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
      {retaining ? (
        <Suspense fallback={null}>
          <RetentionDialog
            artifactId={retaining}
            onClose={() => setRetaining(undefined)}
            scope={scope}
          />
        </Suspense>
      ) : null}
    </section>
  );
}

/** A date input's day, as the end of that local day in UTC; empty keeps the file indefinitely. */
function endOfLocalDay(day: string): string | null | undefined {
  if (day === "") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(day);
  if (!match) return undefined;
  const end = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 23, 59, 59, 999);
  return end.getTime() > Date.now() ? end.toISOString() : undefined;
}

/** Reads the artifact again first: each download link bumps its version, which a save must match. */
export function RetentionDialog({
  artifactId,
  onClose,
  scope,
}: Readonly<{ artifactId: string; onClose: () => void; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: artifact } = useSuspenseQuery(artifactQuery(scope, artifactId));
  const [day, setDay] = useState(artifact.retentionExpiresAt?.slice(0, 10) ?? "");
  const retentionExpiresAt = endOfLocalDay(day);
  const refresh = () => invalidateRuntime(queryClient, scope);
  return (
    <ActionDialog
      confirmLabel="Save"
      description="After this day the platform deletes the file. Leave it empty to keep the file until its thread is erased."
      invalid={retentionExpiresAt === undefined}
      onClose={onClose}
      onSuccess={() => void refresh()}
      open
      runOnce={() =>
        refreshOnConflict(
          updateArtifactRetentionFn({
            data: {
              artifactId: artifact.artifactId,
              expectedVersion: artifact.version,
              retentionExpiresAt: retentionExpiresAt ?? null,
              scope,
            },
          }),
          refresh,
        )
      }
      successMessage="Retention saved"
      title={`Retention for ${artifact.fileName ?? artifact.name}`}
    >
      <Field>
        <Label>Delete after</Label>
        <DatePicker
          disabledDays={beforeToday()}
          label="Delete after"
          onChange={setDay}
          value={day}
        />
        <Description>A future day, or empty to keep the file.</Description>
      </Field>
    </ActionDialog>
  );
}
