import { CheckListIcon } from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  resolveBody,
  reviewDecisions,
  type BrainReviewItemView,
  type ResolveBody,
  type ReviewDecision,
} from "../../brains/content.ts";
import { resolveBrainReviewItemFn } from "../../data/brain-mutations.ts";
import { brainReviewQuery, invalidateBrain } from "../../data/brain-queries.ts";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Description, Field, Label } from "@/components/ui/field";
import { Link } from "@/components/ui/link";
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
import { ActionDialog, refreshOnConflict } from "../action-dialog.tsx";
import { Icon } from "../icon.tsx";
import { useKeyedSnapshot } from "../keyed-snapshot.ts";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";

const DECISION_LABELS: Readonly<Record<ReviewDecision, string>> = {
  approve: "Approve",
  merge: "Merge entities",
  reject: "Reject",
};

function IdLinks({
  href,
  ids,
}: Readonly<{ href: (id: string) => string; ids: readonly string[] }>) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {ids.map((id) => (
        <Link href={href(id)} key={id}>
          <PublicId value={id} />
        </Link>
      ))}
    </div>
  );
}

function Proposal({ brainPath, item }: Readonly<{ brainPath: string; item: BrainReviewItemView }>) {
  const { proposal } = item;
  switch (proposal.kind) {
    case "entity-merge":
      return (
        <div className="flex flex-col gap-1">
          <span>Aliases {proposal.aliases.join(", ")}</span>
          <IdLinks href={(id) => `${brainPath}/entities/${id}`} ids={proposal.candidateEntityIds} />
        </div>
      );
    case "duplicate-document":
      return <IdLinks href={(id) => `${brainPath}/documents/${id}`} ids={proposal.documentIds} />;
    case "other":
      return item.documentId ? (
        <IdLinks href={(id) => `${brainPath}/documents/${id}`} ids={[item.documentId]} />
      ) : null;
  }
}

export function BrainReview({
  brainId,
  brainPath,
  organizationId,
}: Readonly<{ brainId: string; brainPath: string; organizationId: string }>) {
  const reviewQuery = brainReviewQuery(organizationId, brainId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(reviewQuery);
  const items = data.pages.flatMap((page) => page.items);
  const [resolvingId, setResolvingId] = useState<string>();
  const resolving = items.find((item) => item.id === resolvingId);
  const resolvable = items.some((item) => reviewDecisions(item).length > 0);
  return (
    <div className="flex flex-col gap-4">
      {items.some((item) => item.proposal.kind === "duplicate-document") ? (
        <Text>
          The platform cannot record a decision on a duplicate-document item yet, so those items
          stay open. To remove a copy, open its document and archive or tombstone it.
        </Text>
      ) : null}
      {items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Icon icon={CheckListIcon} />
            </EmptyMedia>
            <EmptyTitle>Nothing to review</EmptyTitle>
            <EmptyDescription>
              A maintenance pass flags active documents with identical content. Indexing proposes
              entity merges, which needs Brain search enabled for the organization.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Proposal</TableHead>
              <TableHead>Created</TableHead>
              {resolvable ? (
                <TableHead>
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>{item.kind}</TableCell>
                <TableCell className="max-w-sm whitespace-normal">{item.reason}</TableCell>
                <TableCell>
                  <Proposal brainPath={brainPath} item={item} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={item.createdAt} />
                </TableCell>
                {resolvable ? (
                  <TableCell className="text-right">
                    {reviewDecisions(item).length > 0 ? (
                      <Button onClick={() => setResolvingId(item.id)} variant="outline">
                        Resolve
                      </Button>
                    ) : null}
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
        queryKey={reviewQuery.queryKey}
      />
      {resolving ? (
        <ResolveDialog
          item={resolving}
          key={`${resolving.id}:${resolving.version}`}
          onClose={() => setResolvingId(undefined)}
          organizationId={organizationId}
        />
      ) : null}
    </div>
  );
}

function ResolveDialog({
  item,
  onClose,
  organizationId,
}: Readonly<{ item: BrainReviewItemView; onClose: () => void; organizationId: string }>) {
  const queryClient = useQueryClient();
  const decisions = reviewDecisions(item);
  const candidates = item.proposal.kind === "entity-merge" ? item.proposal.candidateEntityIds : [];
  const [decision, setDecision] = useState<ReviewDecision>(decisions[0] ?? "approve");
  const [target, setTarget] = useState(candidates[0] ?? "");
  const held = useKeyedSnapshot<ResolveBody>();
  const refresh = () => invalidateBrain(queryClient, organizationId, item.brainId);
  const body =
    decision === "merge"
      ? resolveBody(item, { decision, targetEntityId: target })
      : resolveBody(item, { decision });
  return (
    <ActionDialog
      confirmLabel={DECISION_LABELS[decision]}
      confirmation={decision === "merge" ? "merge" : undefined}
      description="Only merging entities changes data. Approve and reject record your decision."
      destructive={decision === "merge"}
      invalid={decision === "merge" && target === ""}
      onClose={onClose}
      onSuccess={() => void refresh()}
      open
      retryNotice="Submitting again sends this decision unchanged. If the first attempt went through, the repeat either returns the recorded decision or stops at a version conflict; either way the item leaves the queue."
      run={(idempotencyKey, resend) =>
        refreshOnConflict(
          resolveBrainReviewItemFn({
            data: {
              body: held(idempotencyKey, resend, body),
              brainId: item.brainId,
              idempotencyKey,
              reviewItemId: item.id,
              scope: { organizationId },
            },
          }),
          refresh,
        )
      }
      successMessage="Review item resolved"
      title={`Resolve ${item.kind}`}
    >
      <Field>
        <Label>Decision</Label>
        <NativeSelect
          onChange={(event) =>
            setDecision(decisions.find((option) => option === event.target.value) ?? decision)
          }
          value={decision}
        >
          {decisions.map((option) => (
            <option key={option} value={option}>
              {DECISION_LABELS[option]}
            </option>
          ))}
        </NativeSelect>
      </Field>
      {decision === "merge" ? (
        <Field>
          <Label>Merge into</Label>
          <Description>The other candidates merge into this entity.</Description>
          <NativeSelect onChange={(event) => setTarget(event.target.value)} value={target}>
            {candidates.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
    </ActionDialog>
  );
}
