import { BrainIcon, Download04Icon, FileImportIcon } from "@hugeicons/core-free-icons";
import { useMutation, useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { exportSpaceFn } from "../../data/memory-mutations.ts";
import { memoryPagesQuery } from "../../data/memory-queries.ts";
import { UnauthenticatedError } from "../../errors.ts";
import {
  LIFECYCLE_ACTIONS,
  MEMORY_EXPORT_LIMIT,
  MEMORY_STATUSES,
  memoryExportFile,
  type ImportOutcome,
  type LifecycleAction,
  type Memory,
  type MemorySpace,
  type MemoryStatus,
} from "../../memory/model.ts";
import { formatExact } from "../../observability/format.ts";
import { oneOf } from "../../observability/range.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Subheading } from "@/components/ui/heading";
import { toast } from "@/components/ui/sonner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { SingleToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { downloadText } from "../download.ts";
import { Icon } from "../icon.tsx";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { describeProblem, SectionBoundary } from "../section-boundary.tsx";
import {
  ImportDialog,
  ImportRejections,
  LIFECYCLE_LABELS,
  LifecycleDialog,
} from "./memory-dialogs.tsx";
import { StatusBadge } from "@/components/status-badge";

const STATUS_LABELS: Readonly<Record<MemoryStatus, string>> = {
  active: "Active",
  archived: "Archived",
  deleted: "Deleted",
};

type MemoryDialog =
  | { readonly kind: "import" }
  | { readonly kind: "rejected"; readonly outcome: ImportOutcome }
  | { readonly action: LifecycleAction; readonly kind: "lifecycle"; readonly memory: Memory };

export function MemoryContent({ memory }: Readonly<{ memory: Memory }>) {
  if (memory.status === "deleted") {
    return <Text>Deleted. The content is gone.</Text>;
  }
  if (memory.body.kind === "stored") {
    return (
      <Text>
        Stored outside the list ({formatExact(memory.body.byteSize)} bytes). Export the space to
        read it.
      </Text>
    );
  }
  return <p className="line-clamp-4 text-sm/6 whitespace-pre-wrap">{memory.body.text}</p>;
}

function ExportButton({ scope, space }: Readonly<{ scope: EnvironmentScope; space: MemorySpace }>) {
  const mutation = useMutation({
    mutationFn: () => exportSpaceFn({ data: { memorySpaceId: space.id, scope } }),
    onError: (error) => {
      const problem = describeProblem(error, "Export failed");
      toast.error(problem.title, { description: problem.description });
    },
    onSuccess: (result) => {
      const file = memoryExportFile(space.id, result, new Date());
      downloadText(file.content, file.filename, "application/json");
      const count = result.memories.length;
      const exported = `Exported ${formatExact(count)} ${count === 1 ? "memory" : "memories"}`;
      if (result.complete) {
        toast.success(exported);
      } else {
        toast.warning(exported, {
          description: `The console exports at most ${formatExact(MEMORY_EXPORT_LIMIT)} memories. The API's exportMemories operation returns one page at a time; pass each page's nextCursor to read the next.`,
        });
      }
    },
  });
  if (mutation.error instanceof UnauthenticatedError) throw mutation.error;
  return (
    <Button disabled={mutation.isPending} onClick={() => mutation.mutate()} variant="outline">
      <Icon icon={Download04Icon} />
      {mutation.isPending ? "Exporting…" : "Export"}
    </Button>
  );
}

export function MemorySection({
  onStatus,
  scope,
  space,
  status,
}: Readonly<{
  onStatus: (status: MemoryStatus) => void;
  scope: EnvironmentScope;
  space: MemorySpace;
  status: MemoryStatus;
}>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const [dialog, setDialog] = useState<MemoryDialog>();
  const { access } = shell;
  const close = () => setDialog(undefined);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>Memories</Subheading>
        <SingleToggleGroup
          aria-label="Memories shown"
          onValueChange={(next) => {
            const known = oneOf(MEMORY_STATUSES, next);
            if (known) onStatus(known);
          }}
          size="sm"
          value={status}
        >
          {MEMORY_STATUSES.map((option) => (
            <ToggleGroupItem key={option} value={option}>
              {STATUS_LABELS[option]}
            </ToggleGroupItem>
          ))}
        </SingleToggleGroup>
        <div className="ml-auto flex gap-2">
          {access.exportMemories ? <ExportButton scope={scope} space={space} /> : null}
          {access.importMemories && space.status === "active" ? (
            <Button onClick={() => setDialog({ kind: "import" })} variant="outline">
              <Icon icon={FileImportIcon} />
              Import
            </Button>
          ) : null}
        </div>
      </div>
      <SectionBoundary resetKey={status}>
        <MemoryTable onAction={setDialog} scope={scope} space={space} status={status} />
      </SectionBoundary>
      {dialog?.kind === "import" ? (
        <ImportDialog
          onClose={() => setDialog((current) => (current?.kind === "import" ? undefined : current))}
          onRejected={(outcome) => setDialog({ kind: "rejected", outcome })}
          scope={scope}
          space={space}
        />
      ) : null}
      {dialog?.kind === "rejected" ? (
        <ImportRejections onClose={close} outcome={dialog.outcome} />
      ) : null}
      {dialog?.kind === "lifecycle" ? (
        <LifecycleDialog
          action={dialog.action}
          memory={dialog.memory}
          onClose={close}
          scope={scope}
        />
      ) : null}
    </section>
  );
}

const ACTION_ACCESS = {
  archive: "archiveMemory",
  delete: "deleteMemory",
  restore: "restoreMemory",
} as const satisfies Readonly<Record<LifecycleAction, string>>;

function MemoryTable({
  onAction,
  scope,
  space,
  status,
}: Readonly<{
  onAction: (dialog: MemoryDialog) => void;
  scope: EnvironmentScope;
  space: MemorySpace;
  status: MemoryStatus;
}>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const pagesQuery = memoryPagesQuery(scope, space.id, status);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const memories = data.pages.flatMap((page) => page.items);
  const { access } = shell;
  if (memories.length === 0) {
    return (
      <ListEmpty
        docs="/docs/capabilities/memory"
        icon={BrainIcon}
        title={`No ${STATUS_LABELS[status].toLowerCase()} memories`}
      >
        Agents with a read-write grant save memories here, and an import adds them in bulk.
      </ListEmpty>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Table striped>
        <TableHeader>
          <TableRow>
            <TableHead>Content</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Review</TableHead>
            <TableHead>Sensitivity</TableHead>
            <TableHead>Updated</TableHead>
            <TableHead>ID</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {memories.map((memory) => (
            <TableRow key={memory.id}>
              <TableCell className="max-w-md whitespace-normal">
                <MemoryContent memory={memory} />
              </TableCell>
              <TableCell>{memory.memoryType ?? "Not set"}</TableCell>
              <TableCell>
                <StatusBadge status={memory.reviewStatus} />
              </TableCell>
              <TableCell>{memory.sensitivity}</TableCell>
              <TableCell className="whitespace-nowrap">
                <Timestamp value={memory.updatedAt} />
              </TableCell>
              <TableCell>
                <PublicId value={memory.id} />
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-2">
                  {LIFECYCLE_ACTIONS[memory.status]
                    .filter((action) => access[ACTION_ACCESS[action]])
                    .filter((action) => action !== "restore" || space.status === "active")
                    .map((action) => (
                      <Button
                        key={action}
                        onClick={() => onAction({ action, kind: "lifecycle", memory })}
                        variant={action === "delete" ? "destructive" : "outline"}
                      >
                        {LIFECYCLE_LABELS[action]}
                      </Button>
                    ))}
                </div>
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
        queryKey={pagesQuery.queryKey}
      />
    </div>
  );
}
