import { BubbleChatIcon } from "@hugeicons/core-free-icons";
import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { threadPagesQuery, threadQuery } from "../../../data/agent-email-mailbox-queries.ts";
import { subjectLabel, type ThreadSearch } from "../../../email/mailbox-state.ts";
import { environmentPath, type EnvironmentScope } from "../../../scope.ts";
import { Heading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text, TextLink } from "@/components/ui/text";
import { ListEmpty, LoadMore } from "../../list-controls.tsx";
import { Timestamp } from "../../observability/panels.tsx";
import { SectionBoundary } from "../../section-boundary.tsx";
import { SearchBox } from "./message-views.tsx";
import { StatusBadge } from "@/components/status-badge";

const PARTICIPANTS_SHOWN = 3;

export function ThreadList({
  inboxId,
  onSearch,
  scope,
  search,
}: Readonly<{
  inboxId: string;
  onSearch: (search: ThreadSearch) => void;
  scope: EnvironmentScope;
  search: ThreadSearch;
}>) {
  return (
    <div className="flex flex-col gap-4">
      <SearchBox
        label="Search threads"
        onSearch={(q) => onSearch(q === undefined ? {} : { q })}
        value={search.q}
      />
      <SectionBoundary resetKey={search.q ?? ""}>
        <ThreadTable inboxId={inboxId} scope={scope} search={search} />
      </SectionBoundary>
    </div>
  );
}

function ThreadTable({
  inboxId,
  scope,
  search,
}: Readonly<{ inboxId: string; scope: EnvironmentScope; search: ThreadSearch }>) {
  const pagesQuery = threadPagesQuery(scope, inboxId, search);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const threads = data.pages.flatMap((page) => page.items);
  const basePath = `${environmentPath(scope)}/email/inboxes/${inboxId}/threads`;
  return (
    <div className="flex flex-col gap-4">
      {threads.length === 0 && hasNextPage ? null : threads.length === 0 ? (
        <ListEmpty
          docs="/docs/capabilities/agent-email"
          icon={BubbleChatIcon}
          title={search.q === undefined ? "No threads" : "No threads match"}
        >
          {search.q === undefined
            ? "Conversations this inbox takes part in appear here."
            : "Change or clear the search."}
        </ListEmpty>
      ) : (
        <Table striped>
          <TableHeader>
            <TableRow>
              <TableHead>Subject</TableHead>
              <TableHead>Participants</TableHead>
              <TableHead className="text-right">Messages</TableHead>
              <TableHead>Last message</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {threads.map((thread) => (
              <TableRow href={`${basePath}/${thread.id}`} key={thread.id} title={thread.subject}>
                <TableCell className="max-w-80 truncate">{subjectLabel(thread.subject)}</TableCell>
                <TableCell className="max-w-80 truncate">
                  {thread.participants.slice(0, PARTICIPANTS_SHOWN).join(", ")}
                  {thread.participants.length > PARTICIPANTS_SHOWN
                    ? ` +${thread.participants.length - PARTICIPANTS_SHOWN}`
                    : ""}
                </TableCell>
                <TableCell className="text-right tabular-nums">{thread.messageCount}</TableCell>
                <TableCell className="whitespace-nowrap">
                  <Timestamp value={thread.lastMessageAt} />
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

export function ThreadDetail({
  inboxId,
  scope,
  threadId,
}: Readonly<{ inboxId: string; scope: EnvironmentScope; threadId: string }>) {
  const detailQuery = threadQuery(scope, inboxId, threadId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(detailQuery);
  const [first] = data.pages;
  const messages = data.pages.flatMap((page) => page.messages);
  const messagePath = `${environmentPath(scope)}/email/messages`;
  return (
    <div className="flex flex-col gap-6">
      {first ? (
        <div className="flex flex-col gap-1">
          <Heading level={2}>{subjectLabel(first.thread.subject)}</Heading>
          <Text>{first.thread.participants.join(", ")}</Text>
        </div>
      ) : null}
      <ol className="flex flex-col gap-4">
        {messages.map((message) => (
          <li className="flex flex-col gap-2 rounded-lg border border-border p-4" key={message.id}>
            <div className="flex flex-wrap items-center gap-2 text-sm/6">
              <span className="font-medium text-foreground">{message.fromAddress}</span>
              <span className="text-muted-foreground">to {message.toAddresses.join(", ")}</span>
              <StatusBadge status={message.status} />
              <span className="ml-auto text-muted-foreground">
                <Timestamp value={message.createdAt} />
              </span>
            </div>
            <TextLink className="self-start text-sm/6" href={`${messagePath}/${message.id}`}>
              Open message
            </TextLink>
          </li>
        ))}
      </ol>
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={detailQuery.queryKey}
      />
    </div>
  );
}
