import { FileUploadIcon, FolderUploadIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { BRAIN_RETRY_NOTICES, type BrainSource, type BrainView } from "../../brains/model.ts";
import { createUploadSourceFn } from "../../data/brain-mutations.ts";
import { brainSourcesQuery, invalidateBrain } from "../../data/brain-queries.ts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ActionDialog } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { UploadDocumentDialog } from "./upload-dialog.tsx";
import { StatusBadge } from "@/components/status-badge";

export function BrainSources({
  brainPath,
  view,
}: Readonly<{ brainPath: string; view: BrainView }>) {
  const { brain, standing } = view;
  const sourcesQuery = brainSourcesQuery(brain.organizationId, brain.id);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(sourcesQuery);
  const sources = data.pages.flatMap((page) => page.items);
  const [adding, setAdding] = useState(false);
  const [uploadingTo, setUploadingTo] = useState<BrainSource>();
  const owner = standing.kind === "owner";
  return (
    <div className="flex flex-col gap-4">
      {owner ? (
        <div>
          <Button onClick={() => setAdding(true)} variant="outline">
            <Icon icon={PlusSignIcon} />
            Add upload source
          </Button>
        </div>
      ) : null}
      {sources.length === 0 ? (
        <ListEmpty docs="/docs/capabilities/brains" icon={FolderUploadIcon} title="No sources">
          Documents enter a Brain through a source. The console adds upload sources; GitHub sources
          sync every hour and cannot be paused or removed, so they are added through the API.
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last sync</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sources.map((source) => (
              <TableRow key={source.id}>
                <TableCell>{source.name}</TableCell>
                <TableCell>{source.kind}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1">
                    <StatusBadge status={source.status} />
                    {source.syncError ? (
                      <Badge color="red" title={source.syncError}>
                        sync failing
                      </Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  {source.lastSyncAt ? <Timestamp value={source.lastSyncAt} /> : "—"}
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={source.createdAt} />
                </TableCell>
                <TableCell className="text-right">
                  {source.kind === "upload" && source.status === "active" ? (
                    <Button onClick={() => setUploadingTo(source)} variant="outline">
                      <Icon icon={FileUploadIcon} />
                      Upload
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
        queryKey={sourcesQuery.queryKey}
      />
      {owner ? (
        <AddUploadSourceDialog
          brainId={brain.id}
          onClose={() => setAdding(false)}
          open={adding}
          organizationId={brain.organizationId}
        />
      ) : null}
      {uploadingTo ? (
        <UploadDocumentDialog
          brainPath={brainPath}
          key={uploadingTo.id}
          onClose={() => setUploadingTo(undefined)}
          open
          organizationId={brain.organizationId}
          source={uploadingTo}
        />
      ) : null}
    </div>
  );
}

function AddUploadSourceDialog({
  brainId,
  onClose,
  open,
  organizationId,
}: Readonly<{ brainId: string; onClose: () => void; open: boolean; organizationId: string }>) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const held = useKeyedSnapshot<string>();
  return (
    <ActionDialog
      confirmLabel="Add source"
      description={
        <>An upload source takes the files you upload to it from the console or through the API.</>
      }
      invalid={name.trim() === ""}
      onClose={() => {
        setName("");
        void invalidateBrain(queryClient, organizationId, brainId);
        onClose();
      }}
      open={open}
      retryNotice={BRAIN_RETRY_NOTICES.uploadSource}
      run={(idempotencyKey, resend) =>
        createUploadSourceFn({
          data: {
            brainId,
            idempotencyKey,
            name: held(idempotencyKey, resend, name.trim()),
            scope: { organizationId },
          },
        })
      }
      successMessage={(source) => `Added ${source.name}`}
      title="Add upload source"
    >
      <Field>
        <Label>Name</Label>
        <Input autoComplete="off" onChange={(event) => setName(event.target.value)} value={name} />
      </Field>
    </ActionDialog>
  );
}
