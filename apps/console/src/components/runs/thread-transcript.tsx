import { Attachment01Icon } from "@hugeicons/core-free-icons";
import {
  useInfiniteQuery,
  useSuspenseInfiniteQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { ClientOnly } from "@tanstack/react-router";
import clsx from "clsx";
import { Fragment, memo, useEffect, useMemo } from "react";
import { organizationShellQuery } from "../../data/console-queries.ts";
import { agentDirectoryQuery } from "../../data/observability-queries.ts";
import { IN_FLIGHT_REFRESH_MS, LIVE_SAFETY_REFRESH_MS } from "../../data/refresh.ts";
import {
  threadQuery,
  threadRunPagesQuery,
  transcriptPagesQuery,
} from "../../data/runtime-queries.ts";
import { agentLabels } from "../../observability/agent-labels.ts";
import { isRunInFlight } from "../../runs/run-state.ts";
import { actorLabel, channelLabel } from "../../runs/thread-labels.ts";
import { formatByteSize, type MessageContent } from "../../runs/views.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { Thread, TranscriptMessage } from "../../server/runtime-data.ts";
import { Badge } from "@/components/ui/badge";
import {
  DescriptionDetails,
  DescriptionList,
  DescriptionTerm,
} from "@/components/ui/description-list";
import { Heading, Subheading } from "@/components/ui/heading";
import { Code, Text, TextLink } from "@/components/ui/text";
import { ThreadAutomations } from "../automations/thread-automations.tsx";
import { Icon } from "../icon.tsx";
import { LoadMore } from "../list-controls.tsx";
import { Timestamp } from "../observability/panels.tsx";
import { PublicId } from "../public-id.tsx";
import { SectionBoundary, SectionSkeleton } from "../section-boundary.tsx";
import { ArtifactList } from "./artifact-list.tsx";
import { Markdown } from "./markdown.tsx";
import { RuntimeRunTable } from "./run-table.tsx";
import { ThreadActions } from "./thread-actions.tsx";
import { useThreadStream, type ThreadStreamView } from "./use-thread-stream.ts";

const ROLE_COLORS = {
  assistant: "blue",
  system: "zinc",
  tool: "amber",
  user: "green",
} as const;

export function ThreadTranscript({
  focusRunId,
  scope,
  threadId,
}: Readonly<{ focusRunId: string | undefined; scope: EnvironmentScope; threadId: string }>) {
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const { data: thread } = useSuspenseQuery(threadQuery(scope, threadId));
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <Heading>{thread.title || "Untitled thread"}</Heading>
        {thread.archived ? <Badge color="zinc">archived</Badge> : null}
        {thread.pinned ? <Badge color="sky">pinned</Badge> : null}
        <ThreadActions scope={scope} thread={thread} />
      </div>
      <ThreadFields scope={scope} thread={thread} />
      <ThreadAutomations scope={scope} threadId={threadId} />
      {shell.access.listArtifacts ? (
        <SectionBoundary fallback={<SectionSkeleton />} resetKey={threadId}>
          <ArtifactList owner={{ kind: "thread", threadId }} scope={scope} />
        </SectionBoundary>
      ) : null}
      {shell.access.listRuns ? (
        <SectionBoundary resetKey={threadId}>
          <ThreadActivity
            canStream={shell.access.createThreadStreamSession}
            focusRunId={focusRunId}
            scope={scope}
            showTranscript={shell.access.listThreadMessages}
            threadId={threadId}
          />
        </SectionBoundary>
      ) : shell.access.listThreadMessages ? (
        <TranscriptSection
          focusRunId={focusRunId}
          refetchInterval={false}
          scope={scope}
          threadId={threadId}
        />
      ) : null}
    </div>
  );
}

function ThreadFields({ scope, thread }: Readonly<{ scope: EnvironmentScope; thread: Thread }>) {
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const { data: shell } = useSuspenseQuery(organizationShellQuery(scope.organizationId));
  const canReadTraces = shell.access.listObservabilitySessionTraces;
  const labels = agentLabels(directory);
  const basePath = environmentPath(scope);
  return (
    <DescriptionList>
      <DescriptionTerm>ID</DescriptionTerm>
      <DescriptionDetails>
        <PublicId value={thread.id} />
      </DescriptionDetails>
      <DescriptionTerm>Deployment</DescriptionTerm>
      <DescriptionDetails>
        {thread.agentDeploymentId ? labels.deployment(thread.agentDeploymentId) : "—"}
      </DescriptionDetails>
      <DescriptionTerm>Channel</DescriptionTerm>
      <DescriptionDetails>{channelLabel(thread.channel)}</DescriptionDetails>
      <DescriptionTerm>Purpose</DescriptionTerm>
      <DescriptionDetails>{thread.executionPurpose}</DescriptionDetails>
      <DescriptionTerm>Created by</DescriptionTerm>
      <DescriptionDetails>
        {actorLabel(thread.createdBy, shell.principalId)}
        {thread.createdBy.id ? (
          <>
            {" "}
            <PublicId value={thread.createdBy.id} />
          </>
        ) : null}
      </DescriptionDetails>
      {thread.externalThreadKey ? (
        <>
          <DescriptionTerm>External key</DescriptionTerm>
          <DescriptionDetails>
            <Code>{thread.externalThreadKey}</Code>
          </DescriptionDetails>
        </>
      ) : null}
      {thread.pinnedAgentReleaseId ? (
        <>
          <DescriptionTerm>Pinned release</DescriptionTerm>
          <DescriptionDetails>
            <PublicId value={thread.pinnedAgentReleaseId} />
          </DescriptionDetails>
        </>
      ) : null}
      {thread.continuedFromThreadId ? (
        <>
          <DescriptionTerm>Continues</DescriptionTerm>
          <DescriptionDetails>
            <TextLink href={`${basePath}/threads/${thread.continuedFromThreadId}`}>
              Thread <Code>…{thread.continuedFromThreadId.slice(-8)}</Code>
            </TextLink>
          </DescriptionDetails>
        </>
      ) : null}
      <DescriptionTerm>Created</DescriptionTerm>
      <DescriptionDetails>
        <Timestamp value={thread.createdAt} />
      </DescriptionDetails>
      <DescriptionTerm>Updated</DescriptionTerm>
      <DescriptionDetails>
        <Timestamp value={thread.updatedAt} />
      </DescriptionDetails>
      {canReadTraces ? (
        <>
          <DescriptionTerm>Traces</DescriptionTerm>
          <DescriptionDetails>
            <TextLink href={`${basePath}/traces/sessions/${thread.id}`}>
              Every trace in this thread
            </TextLink>
          </DescriptionDetails>
        </>
      ) : null}
    </DescriptionList>
  );
}

/** The thread's runs and transcript, refreshed by the live stream while a run is in flight. */
export function ThreadActivity({
  canStream,
  focusRunId,
  scope,
  showRuns = true,
  showTranscript,
  threadId,
}: Readonly<{
  canStream: boolean;
  focusRunId: string | undefined;
  scope: EnvironmentScope;
  showRuns?: boolean;
  showTranscript: boolean;
  threadId: string;
}>) {
  const { data: inFlight } = useSuspenseInfiniteQuery({
    ...threadRunPagesQuery(scope, threadId),
    select: (data) =>
      data.pages.some((page) => page.items.some((run) => isRunInFlight(run.status))),
  });
  const stream = useThreadStream({ enabled: canStream && inFlight, scope, threadId });
  const refetchInterval = inFlight
    ? stream.status === "live"
      ? LIVE_SAFETY_REFRESH_MS
      : IN_FLIGHT_REFRESH_MS
    : false;
  // The stream refreshes the runs on each run event, and this interval only backs it up. It rides
  // on its own observer, not the runs table, so a caller that hides the table still sees runs settle.
  useInfiniteQuery({
    ...threadRunPagesQuery(scope, threadId),
    notifyOnChangeProps: [],
    refetchInterval,
  });
  return (
    <div className="flex flex-col gap-8">
      {showRuns ? <ThreadRuns focusRunId={focusRunId} scope={scope} threadId={threadId} /> : null}
      {showTranscript ? (
        <TranscriptSection
          focusRunId={focusRunId}
          refetchInterval={refetchInterval}
          scope={scope}
          stream={stream}
          threadId={threadId}
        />
      ) : null}
    </div>
  );
}

/** Memoized, so streaming text that re-renders the activity leaves the run table alone. */
const ThreadRuns = memo(function ThreadRuns({
  focusRunId,
  scope,
  threadId,
}: Readonly<{
  focusRunId: string | undefined;
  scope: EnvironmentScope;
  threadId: string;
}>) {
  const { data: directory } = useSuspenseQuery(agentDirectoryQuery(scope));
  const pagesQuery = threadRunPagesQuery(scope, threadId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(pagesQuery);
  const runs = useMemo(() => data.pages.flatMap((page) => page.items), [data.pages]);
  const releases = useMemo(() => data.pages.flatMap((page) => page.releases), [data.pages]);
  const labels = useMemo(() => agentLabels(directory, releases), [directory, releases]);
  const basePath = environmentPath(scope);
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Subheading>Runs</Subheading>
        <TextLink className="ml-auto text-sm/6" href={`${basePath}/runs?threadId=${threadId}`}>
          Open in the runs feed
        </TextLink>
      </div>
      {runs.length === 0 ? (
        <Text>This thread has no runs.</Text>
      ) : (
        <RuntimeRunTable
          environmentPath={basePath}
          focusRunId={focusRunId}
          labels={labels}
          runs={runs}
        />
      )}
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
    </section>
  );
});

function TranscriptSection(
  props: Readonly<{
    focusRunId: string | undefined;
    refetchInterval: number | false;
    scope: EnvironmentScope;
    stream?: ThreadStreamView;
    threadId: string;
  }>,
) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <Subheading>Transcript</Subheading>
        {props.stream?.status === "live" ? <Badge color="green">Live</Badge> : null}
      </div>
      {/* A transcript page can reach 4 MiB; server rendering it would add the markup and its
          dehydrated copy to one response and exceed the Lambda's 6 MB limit. */}
      <ClientOnly fallback={<SectionSkeleton />}>
        <SectionBoundary resetKey={props.threadId}>
          <Transcript {...props} />
        </SectionBoundary>
      </ClientOnly>
    </section>
  );
}

function Transcript({
  focusRunId,
  refetchInterval,
  scope,
  stream,
  threadId,
}: Readonly<{
  focusRunId: string | undefined;
  refetchInterval: number | false;
  scope: EnvironmentScope;
  stream?: ThreadStreamView;
  threadId: string;
}>) {
  const pagesQuery = transcriptPagesQuery(scope, threadId);
  const { data, error, fetchNextPage, hasNextPage, isFetchingNextPage } = useSuspenseInfiniteQuery({
    ...pagesQuery,
    refetchInterval,
  });
  const messages = useMemo(() => data.pages.flatMap((page) => page.items), [data.pages]);
  const basePath = environmentPath(scope);

  useEffect(() => {
    if (focusRunId) document.getElementById(`run-${focusRunId}`)?.scrollIntoView();
  }, [focusRunId]);

  // Streaming text belongs after the newest message, which only the last page holds.
  const drafts = hasNextPage
    ? []
    : (stream?.drafts ?? []).filter(
        (draft) => !messages.some((message) => message.id === draft.messageId),
      );

  if (messages.length === 0 && drafts.length === 0) {
    return <Text>No messages yet.</Text>;
  }
  return (
    <>
      <ol className="flex flex-col gap-3">
        <MessageItems basePath={basePath} focusRunId={focusRunId} messages={messages} />
        {drafts.map((draft) => (
          <li
            className="rounded-lg border border-dashed border-blue-500/40 p-3"
            key={`draft-${draft.messageId}`}
          >
            <div className="flex flex-wrap items-center gap-2 text-xs/5 text-muted-foreground">
              <Badge color={ROLE_COLORS.assistant}>assistant</Badge>
              <span>streaming</span>
            </div>
            <MessageBody content={{ kind: "text", text: draft.text }} markdown />
          </li>
        ))}
      </ol>
      <LoadMore
        error={error}
        fetchNextPage={fetchNextPage}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        queryKey={pagesQuery.queryKey}
      />
    </>
  );
}

/** The loaded messages, memoized so that each batch of streaming text renders only the drafts. */
const MessageItems = memo(function MessageItems({
  basePath,
  focusRunId,
  messages,
}: Readonly<{
  basePath: string;
  focusRunId: string | undefined;
  messages: readonly TranscriptMessage[];
}>) {
  return messages.map((message, index) => {
    const startsRun = message.runId !== undefined && message.runId !== messages[index - 1]?.runId;
    return (
      <Fragment key={message.id}>
        {startsRun && message.runId ? (
          <li
            className="flex scroll-mt-4 items-center gap-3 pt-2 text-xs/5 text-muted-foreground"
            id={`run-${message.runId}`}
          >
            <span className="h-px flex-1 bg-border" />
            <TextLink href={`${basePath}/runs/${message.runId}`}>
              Run <Code>…{message.runId.slice(-8)}</Code>
            </TextLink>
            <span className="h-px flex-1 bg-border" />
          </li>
        ) : null}
        <li
          className={clsx(
            "rounded-lg border p-3",
            message.runId !== undefined && message.runId === focusRunId
              ? "border-amber-500/40 bg-amber-500/5"
              : "border-border",
          )}
        >
          <div className="flex flex-wrap items-center gap-2 text-xs/5 text-muted-foreground">
            <Badge color={ROLE_COLORS[message.role]}>{message.role}</Badge>
            <span className="tabular-nums">#{message.sequence}</span>
            <Timestamp value={message.createdAt} />
          </div>
          <MessageBody content={message.content} markdown={message.role === "assistant"} />
          {message.attachedFileCount > 0 ? (
            <Text className="mt-2 flex items-center gap-1">
              <Icon className="size-4" icon={Attachment01Icon} />
              {message.attachedFileCount} attached{" "}
              {message.attachedFileCount === 1 ? "file" : "files"}
            </Text>
          ) : null}
        </li>
      </Fragment>
    );
  });
});

/** Agent text renders as Markdown; everything else, such as what a person typed, stays verbatim. */
export function MessageBody({
  content,
  markdown = false,
}: Readonly<{ content: MessageContent; markdown?: boolean }>) {
  if (content.kind === "text") {
    return markdown ? (
      <Markdown className="mt-2 space-y-2 text-sm/6 break-words" text={content.text} />
    ) : (
      <p className="mt-2 text-sm/6 break-words whitespace-pre-wrap">{content.text}</p>
    );
  }
  if (content.kind === "external") {
    return (
      <Text className="mt-2">
        Stored outside the message: {formatByteSize(content.byteSize)} of{" "}
        <Code>{content.contentType}</Code>.{" "}
        <TextLink href={content.url} rel="noreferrer" target="_blank">
          Open the body
        </TextLink>{" "}
        (the link expires <Timestamp value={content.expiresAt} />; reload the page for a new one).
      </Text>
    );
  }
  return <Text className="mt-2">No body.</Text>;
}
