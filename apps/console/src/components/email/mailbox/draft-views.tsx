import { FileEditIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import {
  useQuery,
  useQueryClient,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { environmentQuery, organizationShellQuery } from "../../../data/console-queries.ts";
import { inboxQuery } from "../../../data/agent-email-inbox-queries.ts";
import {
  rejectDraftFn,
  sendDraftFn,
  stepDraftFn,
} from "../../../data/agent-email-mailbox-mutations.ts";
import {
  composeContextQuery,
  draftPagesQuery,
  draftQuery,
} from "../../../data/agent-email-mailbox-queries.ts";
import { invalidateAgentEmail } from "../../../data/agent-email-setup-queries.ts";
import {
  classifyRecipients,
  composeContext,
  sendConfirmation,
  type AgentEmailMessage,
} from "../../../email/compose-state.ts";
import {
  DRAFT_STATUSES,
  draftActions,
  draftReasonLabel,
  freshDraft,
  type AgentEmailDraft,
  type DraftAction,
} from "../../../email/draft-lifecycle.ts";
import { parseDraftSearch, subjectLabel, type DraftSearch } from "../../../email/mailbox-state.ts";
import { environmentPath, type EnvironmentScope } from "../../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Description, Field, Label } from "@/components/ui/field";
import { Heading, Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text, TextLink } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { ActionDialog } from "../../action-dialog.tsx";
import { BackLink } from "../../back-link.tsx";
import { Icon } from "../../icon.tsx";
import { ListEmpty, FilterSelect, LoadMore } from "../../list-controls.tsx";
import { SectionBoundary } from "../../section-boundary.tsx";
import { Timestamp } from "../../observability/panels.tsx";
import { ComposeDialog, RecipientList, RecipientReadProblem } from "./compose-dialog.tsx";
import { Addresses, MailBody } from "./message-views.tsx";
import { StatusBadge } from "@/components/status-badge";

const ACTION_LABELS: Readonly<Record<DraftAction, string>> = {
  approve: "Approve",
  cancel: "Cancel draft",
  edit: "Edit",
  reject: "Reject",
  send: "Send",
  submit: "Submit for approval",
};

const STEP_COPY: Readonly<
  Record<
    "approve" | "cancel" | "submit",
    { readonly description: string; readonly success: string }
  >
> = {
  approve: {
    description: "Approving does not send. Anyone who may send drafts can then send it.",
    success: "Draft approved",
  },
  cancel: {
    description:
      "A canceled draft cannot be edited or sent. Canceling a scheduled draft also cancels its scheduled message.",
    success: "Draft canceled",
  },
  submit: {
    description: "Locks the draft for review. An owner or admin approves or rejects it.",
    success: "Draft submitted",
  },
};

export function DraftList({
  inboxId,
  onSearch,
  scope,
  search,
}: Readonly<{
  inboxId: string;
  onSearch: (search: DraftSearch) => void;
  scope: EnvironmentScope;
  search: DraftSearch;
}>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: inbox } = useSuspenseQuery(inboxQuery(scope, inboxId));
  const [creating, setCreating] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <FilterSelect
          label="Status"
          onChange={(status) => onSearch(parseDraftSearch({ status }))}
          options={DRAFT_STATUSES.map((value) => ({ label: value, value }))}
          value={search.status}
        />
        {shell.access.createAgentEmailDraft ? (
          <Button className="ml-auto" onClick={() => setCreating(true)}>
            <Icon icon={PlusSignIcon} />
            New draft
          </Button>
        ) : null}
      </div>
      <SectionBoundary resetKey={search.status ?? ""}>
        <DraftTable inboxId={inboxId} scope={scope} search={search} />
      </SectionBoundary>
      {creating ? (
        <ComposeDialog
          inbox={inbox}
          mode={{ kind: "draft" }}
          onClose={() => setCreating(false)}
          scope={scope}
        />
      ) : null}
    </div>
  );
}

function DraftTable({
  inboxId,
  scope,
  search,
}: Readonly<{ inboxId: string; scope: EnvironmentScope; search: DraftSearch }>) {
  const pagesQuery = draftPagesQuery(scope, inboxId, search);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const drafts = data.pages.flatMap((page) => page.items);
  const basePath = `${environmentPath(scope)}/email/drafts`;
  return (
    <div className="flex flex-col gap-4">
      {drafts.length === 0 && hasNextPage ? null : drafts.length === 0 ? (
        <ListEmpty
          docs="/docs/capabilities/agent-email"
          icon={FileEditIcon}
          title={search.status === undefined ? "No drafts" : "No drafts match"}
        >
          {search.status === undefined
            ? "Drafts wait for review before they send."
            : "Change or clear the filters."}
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Subject</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {drafts.map((draft) => (
              <TableRow href={`${basePath}/${draft.id}`} key={draft.id} title={draft.subject}>
                <TableCell className="max-w-80 truncate">{subjectLabel(draft.subject)}</TableCell>
                <TableCell className="max-w-64 truncate">
                  {draft.toAddresses.join(", ") || "—"}
                </TableCell>
                <TableCell>
                  <StatusBadge status={draft.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={draft.updatedAt} />
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

function StepDialog({
  draft,
  onClose,
  scope,
  step,
}: Readonly<{
  draft: AgentEmailDraft;
  onClose: () => void;
  scope: EnvironmentScope;
  step: "approve" | "cancel" | "submit";
}>) {
  const queryClient = useQueryClient();
  return (
    <ActionDialog
      confirmLabel={ACTION_LABELS[step]}
      description={STEP_COPY[step].description}
      destructive={step === "cancel"}
      onClose={onClose}
      onSuccess={() => void invalidateAgentEmail(queryClient, scope)}
      open
      run={(idempotencyKey) =>
        stepDraftFn({ data: { draftId: draft.id, idempotencyKey, scope, step } })
      }
      successMessage={STEP_COPY[step].success}
      title={`${ACTION_LABELS[step]}: ${subjectLabel(draft.subject)}`}
    />
  );
}

function RejectDialog({
  draft,
  onClose,
  scope,
}: Readonly<{ draft: AgentEmailDraft; onClose: () => void; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  return (
    <ActionDialog
      confirmLabel="Reject"
      description="The author can edit a rejected draft and submit it again."
      destructive
      invalid={trimmed.length === 0 || trimmed.length > 2_000}
      onClose={onClose}
      onSuccess={() => void invalidateAgentEmail(queryClient, scope)}
      open
      run={(idempotencyKey) =>
        rejectDraftFn({
          data: { body: { reason: trimmed }, draftId: draft.id, idempotencyKey, scope },
        })
      }
      successMessage="Draft rejected"
      title={`Reject: ${subjectLabel(draft.subject)}`}
    >
      <Field>
        <Label>Reason</Label>
        <Description>Shown to the author. Up to 2,000 characters.</Description>
        <Textarea onChange={(event) => setReason(event.target.value)} rows={4} value={reason} />
      </Field>
    </ActionDialog>
  );
}

function SendDraftDialog({
  draft,
  onClose,
  scope,
}: Readonly<{ draft: AgentEmailDraft; onClose: () => void; scope: EnvironmentScope }>) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: environment } = useSuspenseQuery(environmentQuery(scope));
  const context = composeContext(useQuery(composeContextQuery(scope, draft.inboxId)));
  const ready = context.kind === "ready" ? context.context : undefined;
  const fresh = freshDraft(useQuery({ ...draftQuery(scope, draft.id), refetchOnMount: "always" }));
  const current = fresh.kind === "ready" ? fresh.draft : undefined;
  const classes = classifyRecipients(
    current ? [...current.toAddresses, ...current.ccAddresses, ...current.bccAddresses] : [],
    new Set(ready?.ownInboxes ?? []),
    ready?.allowlist ?? [],
  );
  return (
    <ActionDialog<AgentEmailMessage>
      confirmLabel={draft.scheduledAt ? "Schedule" : "Send"}
      confirmation={ready && current ? sendConfirmation(classes, environment.type) : undefined}
      description="Recipients outside this environment receive real mail."
      invalid={ready === undefined || current === undefined}
      onClose={onClose}
      onSuccess={(message) => {
        void invalidateAgentEmail(queryClient, scope);
        void navigate({
          params: {
            envId: scope.environmentId,
            messageId: message.id,
            orgId: scope.organizationId,
            projectId: scope.projectId,
          },
          to: "/o/$orgId/p/$projectId/e/$envId/email/messages/$messageId",
        });
      }}
      open
      retryNotice="Submitting again resends this request with the same key, so the draft goes out at most once."
      run={(idempotencyKey) => sendDraftFn({ data: { draftId: draft.id, idempotencyKey, scope } })}
      successMessage={draft.scheduledAt ? "Draft scheduled" : "Draft queued"}
      title={`Send: ${subjectLabel(draft.subject)}`}
    >
      {fresh.kind === "failed" ? (
        <RecipientReadProblem error={fresh.error} title="The latest recipients could not be read" />
      ) : context.kind === "failed" ? (
        <RecipientReadProblem
          error={context.error}
          title="This environment's inboxes and allowlist could not be read"
        />
      ) : current === undefined || ready === undefined ? (
        <Text>Reading the latest recipients…</Text>
      ) : (
        <RecipientList classes={classes} complete={ready.complete} />
      )}
    </ActionDialog>
  );
}

export function DraftDetail({
  draftId,
  scope,
}: Readonly<{ draftId: string; scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: draft } = useSuspenseQuery(draftQuery(scope, draftId));
  const { data: inbox } = useSuspenseQuery(inboxQuery(scope, draft.inboxId));
  const [action, setAction] = useState<DraftAction>();
  const actions = draftActions(draft.status, shell.access);
  const close = () => setAction(undefined);
  const base = environmentPath(scope);
  return (
    <div className="flex flex-col gap-8">
      <BackLink href={`${base}/email/inboxes/${draft.inboxId}/drafts`} label={inbox.address} />
      <div className="flex flex-wrap items-center gap-3">
        <Heading>{subjectLabel(draft.subject)}</Heading>
        <StatusBadge status={draft.status} />
        <div className="ml-auto flex flex-wrap gap-3">
          {actions.map((next) => (
            <Button
              key={next}
              onClick={() => setAction(next)}
              variant={
                next === "send"
                  ? "default"
                  : next === "cancel" || next === "reject"
                    ? "destructive"
                    : "outline"
              }
            >
              {ACTION_LABELS[next]}
            </Button>
          ))}
        </div>
      </div>
      <DescriptionList>
        <DescriptionTerm>From</DescriptionTerm>
        <DescriptionDetails>
          <TextLink href={`${base}/email/inboxes/${inbox.id}/drafts`}>{inbox.address}</TextLink>
        </DescriptionDetails>
        <Addresses label="To" values={draft.toAddresses} />
        <Addresses label="Cc" values={draft.ccAddresses} />
        <Addresses label="Bcc" values={draft.bccAddresses} />
        {draft.scheduledAt ? (
          <>
            <DescriptionTerm>Send at</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={draft.scheduledAt} />
            </DescriptionDetails>
          </>
        ) : null}
        {draft.approvedAt ? (
          <>
            <DescriptionTerm>Approved</DescriptionTerm>
            <DescriptionDetails>
              <Timestamp value={draft.approvedAt} />
            </DescriptionDetails>
          </>
        ) : null}
        {draft.failureReason ? (
          <>
            <DescriptionTerm>{draftReasonLabel(draft)}</DescriptionTerm>
            <DescriptionDetails>{draft.failureReason}</DescriptionDetails>
          </>
        ) : null}
        {draft.sentMessageId ? (
          <>
            <DescriptionTerm>Message</DescriptionTerm>
            <DescriptionDetails>
              <TextLink href={`${base}/email/messages/${draft.sentMessageId}`}>
                Open the message
              </TextLink>
            </DescriptionDetails>
          </>
        ) : null}
        <DescriptionTerm>Updated</DescriptionTerm>
        <DescriptionDetails>
          <Timestamp value={draft.updatedAt} />
        </DescriptionDetails>
      </DescriptionList>
      <section className="flex flex-col gap-3">
        <Subheading>Body</Subheading>
        <MailBody message={draft} rawDownload={false} />
      </section>
      {actions.length === 0 ? (
        <Text>No further action applies to a {draft.status} draft.</Text>
      ) : null}
      {action === "edit" ? (
        <ComposeDialog
          inbox={inbox}
          mode={{ draft, kind: "draft" }}
          onClose={close}
          scope={scope}
        />
      ) : null}
      {action === "approve" || action === "cancel" || action === "submit" ? (
        <StepDialog draft={draft} onClose={close} scope={scope} step={action} />
      ) : null}
      {action === "reject" ? <RejectDialog draft={draft} onClose={close} scope={scope} /> : null}
      {action === "send" ? <SendDraftDialog draft={draft} onClose={close} scope={scope} /> : null}
    </div>
  );
}
