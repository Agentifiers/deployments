import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { environmentQuery } from "../../data/console-queries.ts";
import { changeLifecycleFn, importMemoriesFn } from "../../data/memory-mutations.ts";
import { invalidateMemory } from "../../data/memory-queries.ts";
import {
  importRequest,
  MEMORY_TYPES,
  type ImportDraft,
  type ImportOutcome,
  type LifecycleAction,
  type Memory,
  type MemorySpace,
} from "../../memory/model.ts";
import { formatExact } from "../../observability/format.ts";
import { oneOf } from "../../observability/range.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Description, ErrorMessage, Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog, refreshOnConflict, typedConfirmation } from "../action-dialog.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";

export const LIFECYCLE_LABELS: Readonly<Record<LifecycleAction, string>> = {
  archive: "Archive",
  delete: "Delete",
  restore: "Restore",
};

const LIFECYCLE_COPY: Readonly<Record<LifecycleAction, string>> = {
  archive:
    "An archived memory can be restored later, unless its space is archived or an approved memory that replaces it is active. Only archived memories can be deleted.",
  delete:
    "Deleting removes the memory's content permanently. The record stays as a deleted tombstone, and it cannot be restored.",
  restore:
    "The memory becomes active again. If it replaces an older memory, restoring it archives that one.",
};

function importSummary(outcome: ImportOutcome): string {
  const parts = [`Imported ${formatExact(outcome.imported)}`];
  if (outcome.replayed > 0) parts.push(`${formatExact(outcome.replayed)} already imported`);
  if (outcome.rejected.length > 0) parts.push(`${formatExact(outcome.rejected.length)} rejected`);
  return parts.join(", ");
}

export function ImportDialog({
  onClose,
  onRejected,
  scope,
  space,
}: Readonly<{
  onClose: () => void;
  onRejected: (outcome: ImportOutcome) => void;
  scope: EnvironmentScope;
  space: MemorySpace;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [draft, setDraft] = useState<ImportDraft>({ memoryType: "unset", text: "" });
  const parsed = importRequest(space, draft);
  const owner =
    space.workspaceId === undefined
      ? "one organization-scoped memory"
      : "one memory in the space's workspace";
  return (
    <ActionDialog<ImportOutcome>
      confirmLabel="Import"
      confirmation={typedConfirmation(environment.type, { phrase: space.name })}
      description={`Each block of text separated by a blank line becomes ${owner}, with each run of whitespace collapsed to one space. An import takes at most 100 memories and 4 MiB, and each memory at most 8,000 bytes after the collapse.`}
      invalid={!parsed.ok}
      onClose={onClose}
      onSuccess={(outcome) => {
        void invalidateMemory(queryClient, scope);
        if (outcome.rejected.length > 0) onRejected(outcome);
      }}
      open
      retryNotice="Part of this import may have been stored. Submitting again resends the same import with the same key."
      run={(idempotencyKey) => {
        if (!parsed.ok) throw new TypeError(parsed.problem);
        return importMemoriesFn({ data: { body: parsed.request, idempotencyKey, scope } });
      }}
      size="2xl"
      successMessage={importSummary}
      title={`Import memories into ${space.name}`}
    >
      <Field>
        <Label>Memories</Label>
        <Textarea
          onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          rows={10}
          value={draft.text}
        />
      </Field>
      <Field>
        <Label>Memory type</Label>
        <NativeSelect
          onChange={(event) => {
            const memoryType = oneOf(["unset", ...MEMORY_TYPES] as const, event.target.value);
            if (memoryType) setDraft({ ...draft, memoryType });
          }}
          value={draft.memoryType}
        >
          <option value="unset">Not set</option>
          {MEMORY_TYPES.map((memoryType) => (
            <option key={memoryType} value={memoryType}>
              {memoryType}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {draft.text.trim() !== "" && !parsed.ok ? (
        <ErrorMessage>{parsed.problem}</ErrorMessage>
      ) : null}
    </ActionDialog>
  );
}

export function ImportRejections({
  onClose,
  outcome,
}: Readonly<{ onClose: () => void; outcome: ImportOutcome }>) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open
    >
      <DialogContent showCloseButton={false} size="2xl">
        <DialogHeader>
          <DialogTitle>Some memories were not imported</DialogTitle>
          <DialogDescription>
            {importSummary(outcome)}. The platform stored the other blocks and refused these.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2 text-sm/6">
          {outcome.rejected.map((rejection) => (
            <li key={rejection.index}>
              Block {formatExact(rejection.index + 1)}: {rejection.reason}
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LifecycleDialog({
  action,
  memory,
  onClose,
  scope,
}: Readonly<{
  action: LifecycleAction;
  memory: Memory;
  onClose: () => void;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [reason, setReason] = useState("");
  const reasonFor = useKeyedSnapshot<string | undefined>();
  const destructive = action === "delete";
  const trimmed = reason.trim();
  return (
    <ActionDialog<Memory>
      confirmLabel={LIFECYCLE_LABELS[action]}
      confirmation={typedConfirmation(environment.type, { destructive, phrase: memory.id })}
      description={LIFECYCLE_COPY[action]}
      destructive={destructive}
      onClose={onClose}
      onSuccess={() => void invalidateMemory(queryClient, scope)}
      open
      retryNotice="The change may have applied. Submitting again resends the same request with the same key."
      run={(idempotencyKey, resend) => {
        const sent = reasonFor(
          idempotencyKey,
          resend,
          destructive && trimmed !== "" ? trimmed : undefined,
        );
        return refreshOnConflict(
          changeLifecycleFn({
            data: {
              action,
              idempotencyKey,
              memoryId: memory.id,
              scope,
              ...(sent === undefined ? {} : { reason: sent }),
            },
          }),
          () => invalidateMemory(queryClient, scope),
        );
      }}
      successMessage={`Memory ${memory.id} ${action}d`}
      title={`${LIFECYCLE_LABELS[action]} this memory?`}
    >
      {destructive ? (
        <Field>
          <Label>Reason</Label>
          <Description>Optional. The platform records it with the deletion.</Description>
          <Input
            autoComplete="off"
            onChange={(event) => setReason(event.target.value)}
            value={reason}
          />
        </Field>
      ) : null}
    </ActionDialog>
  );
}
