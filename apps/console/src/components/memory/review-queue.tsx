import { TaskDone01Icon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { environmentQuery, organizationShellQuery } from "../../data/console-queries.ts";
import { resolveReviewFn } from "../../data/memory-mutations.ts";
import { invalidateMemory, reviewPagesQuery } from "../../data/memory-queries.ts";
import { reviewKindLabel } from "../../memory/copy.ts";
import {
  REVIEW_DECISIONS,
  REVIEW_SCAN_LIMIT,
  reviewRequest,
  type ReviewDecision,
  type ReviewEntry,
  type ReviewRequest,
} from "../../memory/model.ts";
import { formatExact } from "../../observability/format.ts";
import { oneOf } from "../../observability/range.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Description, ErrorMessage, Field, Label } from "@/components/ui/field";
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
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog, refreshOnConflict, typedConfirmation } from "../action-dialog.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";
import { ListEmpty, LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { MemoryContent } from "./memory-section.tsx";
import { StatusBadge } from "@/components/status-badge";

const DECISION_COPY: Readonly<Record<ReviewDecision, string>> = {
  approve: "Approve the memory as it stands.",
  archive:
    "Archive the memory. Archiving a memory that is still pending review opens a new review item for it.",
  delete: "Delete the memory's content permanently. The record stays as a deleted tombstone.",
  edit: "Replace the memory's content with the text below.",
  reject: "Reject the memory.",
};

function MissingMemory({
  memoryId,
  scannedAllMemories,
}: Readonly<{ memoryId: string; scannedAllMemories: boolean }>) {
  return (
    <Text>
      {scannedAllMemories
        ? "Not an active or archived memory."
        : `Not among the first ${formatExact(REVIEW_SCAN_LIMIT)} active and archived memories the console read.`}{" "}
      Memory <PublicId value={memoryId} />
    </Text>
  );
}

export function ReviewQueue({ scope }: Readonly<{ scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const pagesQuery = reviewPagesQuery(scope);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const [resolving, setResolving] = useState<ReviewEntry>();
  const rows = data.pages.flatMap((page) =>
    page.items.map((entry) => ({ entry, scannedAllMemories: page.scannedAllMemories })),
  );
  const partial = data.pages.some((page) => !page.scannedAllMemories);
  const { access } = shell;
  if (rows.length === 0) {
    return (
      <ListEmpty docs="/docs/capabilities/memory" icon={TaskDone01Icon} title="Nothing to review">
        The platform opens a review item when a memory needs a person's decision.
      </ListEmpty>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {partial ? (
        <Callout>
          <CalloutTitle>Some memories were not found</CalloutTitle>
          <CalloutDescription>
            <p>
              The console reads at most {formatExact(REVIEW_SCAN_LIMIT)} memories, active ones
              first, then archived ones, to show each review item's content. Items whose memory is
              further back show only its ID.
            </p>
          </CalloutDescription>
        </Callout>
      ) : null}
      <Table striped>
        <TableHeader>
          <TableRow>
            <TableHead>Memory</TableHead>
            <TableHead>Kind</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Proposed content</TableHead>
            <TableHead>Opened</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ entry, scannedAllMemories }) => (
            <TableRow key={entry.item.id}>
              <TableCell className="max-w-md whitespace-normal">
                {entry.memory ? (
                  <>
                    <MemoryContent memory={entry.memory} />
                    <StatusBadge status={entry.memory.reviewStatus} />
                  </>
                ) : (
                  <MissingMemory
                    memoryId={entry.item.memoryId}
                    scannedAllMemories={scannedAllMemories}
                  />
                )}
              </TableCell>
              <TableCell>{reviewKindLabel(entry.item.kind)}</TableCell>
              <TableCell className="max-w-xs whitespace-normal">
                {entry.item.reason ?? "None given"}
              </TableCell>
              <TableCell className="max-w-xs whitespace-normal">
                {entry.item.proposedContent ?? "—"}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <Timestamp value={entry.item.createdAt} />
              </TableCell>
              <TableCell>
                {access.resolveMemoryReview ? (
                  <div className="flex justify-end">
                    <Button onClick={() => setResolving(entry)} variant="outline">
                      Resolve
                    </Button>
                  </div>
                ) : null}
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
      {resolving ? (
        <ResolveDialog entry={resolving} onClose={() => setResolving(undefined)} scope={scope} />
      ) : null}
    </div>
  );
}

function ResolveDialog({
  entry,
  onClose,
  scope,
}: Readonly<{ entry: ReviewEntry; onClose: () => void; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const [decision, setDecision] = useState<ReviewDecision>("approve");
  const [content, setContent] = useState(entry.item.proposedContent ?? "");
  const [reason, setReason] = useState("");
  const bodyFor = useKeyedSnapshot<ReviewRequest>();
  const parsed = reviewRequest({ content, decision, reason });
  const destructive = decision === "delete";
  return (
    <ActionDialog<ReviewDecision>
      confirmLabel="Resolve"
      confirmation={typedConfirmation(environment.type, {
        destructive,
        phrase: decision,
      })}
      description={DECISION_COPY[decision]}
      destructive={destructive}
      invalid={!parsed.ok}
      onClose={onClose}
      onSuccess={() => void invalidateMemory(queryClient, scope)}
      open
      retryNotice="The decision may have applied. Submitting again resends the same decision with the same key."
      run={async (idempotencyKey, resend) => {
        if (!parsed.ok) throw new TypeError(parsed.problem);
        const body = bodyFor(idempotencyKey, resend, parsed.request);
        await refreshOnConflict(
          resolveReviewFn({
            data: {
              body,
              idempotencyKey,
              memoryId: entry.item.memoryId,
              reviewId: entry.item.id,
              scope,
            },
          }),
          () => invalidateMemory(queryClient, scope),
        );
        return body.decision;
      }}
      size="2xl"
      successMessage={(sent) => `Review resolved: ${sent}`}
      title="Resolve review item"
    >
      <Field>
        <Label>Decision</Label>
        <NativeSelect
          onChange={(event) => {
            const next = oneOf(REVIEW_DECISIONS, event.target.value);
            if (next) setDecision(next);
          }}
          value={decision}
        >
          {REVIEW_DECISIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {decision === "edit" ? (
        <Field>
          <Label>Replacement content</Label>
          <Textarea onChange={(event) => setContent(event.target.value)} rows={6} value={content} />
        </Field>
      ) : null}
      <Field>
        <Label>Reason</Label>
        <Description>Optional. The platform records it on the review item.</Description>
        <Input
          autoComplete="off"
          onChange={(event) => setReason(event.target.value)}
          value={reason}
        />
      </Field>
      {parsed.ok ? null : <ErrorMessage>{parsed.problem}</ErrorMessage>}
    </ActionDialog>
  );
}
