import {
  Mail01Icon,
  MailReply01Icon,
  MailReplyAll01Icon,
  MailSend01Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { useQueryClient, useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { organizationShellQuery } from "../../../data/console-queries.ts";
import { inboxQuery } from "../../../data/agent-email-inbox-queries.ts";
import {
  mintAttachmentLinkFn,
  mintRawLinkFn,
  reprocessMessageFn,
} from "../../../data/agent-email-mailbox-mutations.ts";
import { messagePagesQuery, messageQuery } from "../../../data/agent-email-mailbox-queries.ts";
import { invalidateAgentEmail } from "../../../data/agent-email-setup-queries.ts";
import type { AgentEmailMessage, ComposeMode } from "../../../email/compose-state.ts";
import {
  MAILBOX_PAGE_SIZE,
  MESSAGE_DIRECTIONS,
  MESSAGE_STATUSES,
  canReprocess,
  mailBodyView,
  messageInFlight,
  opensInBrowser,
  parseMessageSearch,
  rawState,
  subjectLabel,
  type MessageSearch,
  type RawState,
} from "../../../email/mailbox-state.ts";
import { environmentPath, type EnvironmentScope } from "../../../scope.ts";
import { Button } from "@/components/ui/button";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { formatFileSize } from "@/components/ui/file-input";
import { Heading, Subheading } from "@/components/ui/heading";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text, TextLink } from "@/components/ui/text";
import { ActionDialog } from "../../action-dialog.tsx";
import { DocsLink } from "../../docs-link.tsx";
import { FreshLinkButton } from "../../fresh-link.tsx";
import { BackLink } from "../../back-link.tsx";
import { Icon } from "../../icon.tsx";
import { ListEmpty, FilterSelect, LoadMore } from "../../list-controls.tsx";
import { Timestamp } from "../../observability/panels.tsx";
import { PublicId } from "../../public-id.tsx";
import { SectionBoundary } from "../../section-boundary.tsx";
import { ComposeDialog } from "./compose-dialog.tsx";
import { StatusBadge } from "@/components/status-badge";

export function SearchBox({
  label,
  onSearch,
  value,
}: Readonly<{
  label: string;
  onSearch: (q: string | undefined) => void;
  value: string | undefined;
}>) {
  const [text, setText] = useState(value ?? "");
  const [shownValue, setShownValue] = useState(value);
  if (shownValue !== value) {
    setShownValue(value);
    setText(value ?? "");
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSearch(text.trim() || undefined);
  };
  return (
    <form className="flex w-80 gap-2" onSubmit={submit}>
      <Input
        aria-label={label}
        onChange={(event) => setText(event.target.value)}
        placeholder={label}
        type="search"
        value={text}
      />
      <Button variant="outline" type="submit">
        Search
      </Button>
    </form>
  );
}

export function MessageList({
  inboxId,
  onSearch,
  scope,
  search,
}: Readonly<{
  inboxId: string;
  onSearch: (search: MessageSearch) => void;
  scope: EnvironmentScope;
  search: MessageSearch;
}>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: inbox } = useSuspenseQuery(inboxQuery(scope, inboxId));
  const [composing, setComposing] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <SearchBox
          label="Search messages"
          onSearch={(q) => onSearch(parseMessageSearch({ ...search, q }))}
          value={search.q}
        />
        <FilterSelect
          label="Direction"
          onChange={(direction) => onSearch(parseMessageSearch({ ...search, direction }))}
          options={MESSAGE_DIRECTIONS.map((value) => ({ label: value, value }))}
          value={search.direction}
        />
        <FilterSelect
          label="Status"
          onChange={(status) => onSearch(parseMessageSearch({ ...search, status }))}
          options={MESSAGE_STATUSES.map((value) => ({ label: value, value }))}
          value={search.status}
        />
        {shell.access.sendAgentEmailMessage && inbox.status === "active" ? (
          <Button className="ml-auto" onClick={() => setComposing(true)}>
            <Icon icon={MailSend01Icon} />
            Send message
          </Button>
        ) : null}
      </div>
      <SectionBoundary resetKey={JSON.stringify(search)}>
        <MessageTable inboxId={inboxId} scope={scope} search={search} />
      </SectionBoundary>
      {composing ? (
        <ComposeDialog
          inbox={inbox}
          mode={{ kind: "send" }}
          onClose={() => setComposing(false)}
          scope={scope}
        />
      ) : null}
    </div>
  );
}

function MessageTable({
  inboxId,
  scope,
  search,
}: Readonly<{ inboxId: string; scope: EnvironmentScope; search: MessageSearch }>) {
  const pagesQuery = messagePagesQuery(scope, inboxId, search);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const messages = data.pages.flatMap((page) => page.items);
  const filtered =
    search.q !== undefined || search.direction !== undefined || search.status !== undefined;
  const shortSearchPage =
    search.q !== undefined &&
    hasNextPage &&
    (data.pages.at(-1)?.items.length ?? 0) < MAILBOX_PAGE_SIZE;
  const basePath = `${environmentPath(scope)}/email/messages`;
  return (
    <div className="flex flex-col gap-4">
      {messages.length === 0 && hasNextPage ? null : messages.length === 0 ? (
        <ListEmpty
          docs="/docs/capabilities/agent-email"
          icon={Mail01Icon}
          title={filtered ? "No messages match" : "No messages"}
        >
          {filtered
            ? "Change or clear the filters."
            : "Mail this inbox sends and receives appears here."}
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Subject</TableHead>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {messages.map((message) => (
              <TableRow href={`${basePath}/${message.id}`} key={message.id} title={message.subject}>
                <TableCell className="max-w-80 truncate">{subjectLabel(message.subject)}</TableCell>
                <TableCell>{message.fromAddress}</TableCell>
                <TableCell className="max-w-64 truncate">
                  {message.toAddresses.join(", ")}
                </TableCell>
                <TableCell>
                  <StatusBadge status={message.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={message.createdAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {messages.length > 0 && shortSearchPage ? (
        <Text>
          Each search request reads {MAILBOX_PAGE_SIZE} stored messages and returns the ones that
          match, so a page of results is often short. A request also stops early after reading 16
          MiB of message bodies. Load more to keep searching.
        </Text>
      ) : null}
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

export function Addresses({
  label,
  values,
}: Readonly<{ label: string; values: readonly string[] }>) {
  if (values.length === 0) return null;
  return (
    <>
      <DescriptionTerm>{label}</DescriptionTerm>
      <DescriptionDetails>{values.join(", ")}</DescriptionDetails>
    </>
  );
}

function MessageFacts({
  message,
  scope,
}: Readonly<{ message: AgentEmailMessage; scope: EnvironmentScope }>) {
  const inboxPath = `${environmentPath(scope)}/email/inboxes/${message.inboxId}`;
  return (
    <DescriptionList>
      <DescriptionTerm>From</DescriptionTerm>
      <DescriptionDetails>{message.fromAddress}</DescriptionDetails>
      <Addresses label="To" values={message.toAddresses} />
      <Addresses label="Cc" values={message.ccAddresses} />
      <Addresses label="Bcc" values={message.bccAddresses} />
      <DescriptionTerm>Direction</DescriptionTerm>
      <DescriptionDetails>{message.direction}</DescriptionDetails>
      <DescriptionTerm>Created</DescriptionTerm>
      <DescriptionDetails>
        <Timestamp value={message.createdAt} />
      </DescriptionDetails>
      {message.scheduledAt ? (
        <>
          <DescriptionTerm>Scheduled for</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={message.scheduledAt} />
          </DescriptionDetails>
        </>
      ) : null}
      {message.deliveredAt ? (
        <>
          <DescriptionTerm>Delivered</DescriptionTerm>
          <DescriptionDetails>
            <Timestamp value={message.deliveredAt} />
          </DescriptionDetails>
        </>
      ) : null}
      {message.failureReason ? (
        <>
          <DescriptionTerm>Failure</DescriptionTerm>
          <DescriptionDetails>
            {message.failureCode ? `${message.failureCode}: ` : ""}
            {message.failureReason}
          </DescriptionDetails>
        </>
      ) : null}
      <DescriptionTerm>Inbox</DescriptionTerm>
      <DescriptionDetails>
        <TextLink href={inboxPath}>
          <PublicId value={message.inboxId} />
        </TextLink>
      </DescriptionDetails>
      {message.threadId ? (
        <>
          <DescriptionTerm>Thread</DescriptionTerm>
          <DescriptionDetails>
            <TextLink href={`${inboxPath}/threads/${message.threadId}`}>
              <PublicId value={message.threadId} />
            </TextLink>
          </DescriptionDetails>
        </>
      ) : null}
      {message.draftId ? (
        <>
          <DescriptionTerm>Draft</DescriptionTerm>
          <DescriptionDetails>
            <TextLink href={`${environmentPath(scope)}/email/drafts/${message.draftId}`}>
              <PublicId value={message.draftId} />
            </TextLink>
          </DescriptionDetails>
        </>
      ) : null}
      {message.reprocessCount > 0 ? (
        <>
          <DescriptionTerm>Reprocessed</DescriptionTerm>
          <DescriptionDetails>
            {message.reprocessCount === 1 ? "Once" : `${message.reprocessCount} times`}
          </DescriptionDetails>
        </>
      ) : null}
    </DescriptionList>
  );
}

function LazyDetails({ children, summary }: Readonly<{ children: ReactNode; summary: string }>) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-sm/6">{summary}</summary>
      {open ? children : null}
    </details>
  );
}

export function MailBody({
  message,
  rawDownload,
}: Readonly<{
  message: Pick<AgentEmailMessage, "htmlBody" | "textBody">;
  rawDownload: boolean;
}>) {
  const view = mailBodyView(message);
  if (view.kind === "empty") return <Text>This message has no body.</Text>;
  return (
    <>
      {view.kind === "text" ? (
        <pre className="text-sm/6 break-words whitespace-pre-wrap text-foreground">{view.text}</pre>
      ) : (
        <Text>
          This message has only an HTML part, and the console never renders HTML. The source below
          is the part's exact content.
          {rawDownload ? " Download the raw message for the original as received." : ""}
        </Text>
      )}
      {view.html === undefined ? null : (
        <LazyDetails summary="Show HTML source">
          <pre className="mt-2 max-h-96 w-full overflow-auto rounded-lg bg-muted p-4 font-mono text-xs/5 break-all whitespace-pre-wrap">
            <code>{view.html}</code>
          </pre>
        </LazyDetails>
      )}
    </>
  );
}

const RAW_LABELS: Readonly<Record<RawState, string>> = {
  absent: "No raw message",
  expired: "Raw message expired",
  purged: "Raw message purged",
  stored: "Download raw message",
};

function ReprocessDialog({
  message,
  onClose,
  open,
  scope,
}: Readonly<{
  message: AgentEmailMessage;
  onClose: () => void;
  open: boolean;
  scope: EnvironmentScope;
}>) {
  const queryClient = useQueryClient();
  return (
    <ActionDialog
      confirmLabel="Reprocess"
      description="Parses the stored original again and replaces the message's content and attachments. Bound agents are not started again."
      onClose={onClose}
      onSuccess={() => void invalidateAgentEmail(queryClient, scope)}
      open={open}
      run={(idempotencyKey) =>
        reprocessMessageFn({ data: { idempotencyKey, messageId: message.id, scope } })
      }
      successMessage="Reprocessing queued"
      title="Reprocess message"
    />
  );
}

export function MessageDetail({
  messageId,
  scope,
}: Readonly<{ messageId: string; scope: EnvironmentScope }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: message } = useSuspenseQuery(messageQuery(scope, messageId));
  const { data: inbox } = useSuspenseQuery(inboxQuery(scope, message.inboxId));
  const [compose, setCompose] = useState<ComposeMode>();
  const [reprocessing, setReprocessing] = useState(false);
  const { access } = shell;
  const canSend = inbox.status === "active";
  const raw = rawState(message, new Date());
  return (
    <div className="flex flex-col gap-8">
      <BackLink
        href={`${environmentPath(scope)}/email/inboxes/${message.inboxId}/messages`}
        label={inbox.address}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Heading>{subjectLabel(message.subject)}</Heading>
        <StatusBadge status={message.status} />
        {messageInFlight(message) ? <Text>Refreshing while it sends.</Text> : null}
        <div className="ml-auto flex flex-wrap gap-3">
          {canSend && access.replyToAgentEmailMessage ? (
            <Button
              onClick={() => setCompose({ all: false, kind: "reply", message })}
              variant="outline"
            >
              <Icon icon={MailReply01Icon} />
              Reply
            </Button>
          ) : null}
          {canSend && access.replyAllToAgentEmailMessage ? (
            <Button
              onClick={() => setCompose({ all: true, kind: "reply", message })}
              variant="outline"
            >
              <Icon icon={MailReplyAll01Icon} />
              Reply all
            </Button>
          ) : null}
          {canSend && access.forwardAgentEmailMessage ? (
            <Button onClick={() => setCompose({ kind: "forward", message })} variant="outline">
              <Icon icon={MailSend01Icon} />
              Forward
            </Button>
          ) : null}
          <FreshLinkButton
            disabled={raw !== "stored"}
            disposition="download"
            label={RAW_LABELS[raw]}
            mint={() => mintRawLinkFn({ data: { messageId: message.id, scope } })}
          />
          {access.reprocessAgentEmailMessage && canReprocess(message, new Date()) ? (
            <Button onClick={() => setReprocessing(true)} variant="outline">
              <Icon icon={RefreshIcon} />
              Reprocess
            </Button>
          ) : null}
        </div>
      </div>
      <MessageFacts message={message} scope={scope} />
      <section className="flex flex-col gap-3">
        <Subheading>Body</Subheading>
        <MailBody message={message} rawDownload={raw === "stored"} />
      </section>
      {message.attachments.length > 0 ? (
        <section className="flex flex-col gap-3">
          <Subheading>Attachments</Subheading>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Size</TableHead>
                <TableHead>
                  <span className="sr-only">Open or ID</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {message.attachments.map((attachment) => (
                <TableRow key={attachment.id}>
                  <TableCell>{attachment.fileName}</TableCell>
                  <TableCell>{attachment.contentType}</TableCell>
                  <TableCell>{formatFileSize(attachment.byteSize)}</TableCell>
                  <TableCell className="text-right">
                    {opensInBrowser(attachment.contentType) ? (
                      <FreshLinkButton
                        disposition="view"
                        label="Open"
                        mint={() =>
                          mintAttachmentLinkFn({ data: { attachmentId: attachment.id, scope } })
                        }
                      />
                    ) : (
                      <PublicId value={attachment.id} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {message.attachments.every((attachment) =>
            opensInBrowser(attachment.contentType),
          ) ? null : (
            <Text>
              The console opens plain text, PNG, JPEG, GIF, WebP, and PDF files. Other files could
              run the sender&apos;s code in your browser, because the platform serves an attachment
              with the type its sender gave it.{" "}
              <DocsLink path="/docs/api/reference/agent-email/create-agent-email-attachment-access-url/">
                Request a link that expires in 300 seconds through the API
              </DocsLink>
              , then save the file with a download tool.
            </Text>
          )}
        </section>
      ) : null}
      {compose ? (
        <ComposeDialog
          inbox={inbox}
          mode={compose}
          onClose={() => setCompose(undefined)}
          scope={scope}
        />
      ) : null}
      <ReprocessDialog
        message={message}
        onClose={() => setReprocessing(false)}
        open={reprocessing}
        scope={scope}
      />
    </div>
  );
}
