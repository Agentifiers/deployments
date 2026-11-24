import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useReducer, useState, type FormEvent, type ReactNode } from "react";
import type { OperationAccess } from "../../access.ts";
import { threadRunPagesQuery, transcriptPagesQuery } from "../../data/runtime-queries.ts";
import { UnauthenticatedError } from "../../errors.ts";
import {
  canSend,
  chatReducer,
  currentRunId,
  NEW_CHAT,
  nextAttempt,
  parseChatMessage,
  type ChatAttempt,
  type ChatEvent,
  type ChatPhase,
} from "../../runs/chat-session.ts";
import { runErrorText } from "../../runs/run-state.ts";
import { environmentPath, type EnvironmentScope } from "../../scope.ts";
import type { SubmittedTurn } from "../../server/chat-actions.ts";
import { Button } from "@/components/ui/button";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import { Field, Label } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Text, TextLink } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { describeProblem } from "../section-boundary.tsx";
import { SectionBoundary } from "../section-boundary.tsx";
import { ThreadActivity } from "./thread-transcript.tsx";

/** Where a chat's messages go: a deployment, or a preview of an unpublished draft. */
export interface ChatTarget {
  /** Submits one message, opening the conversation's thread when it has none yet. */
  readonly submit: (
    attempt: ChatAttempt,
    threadId: string | undefined,
    onThreadOpened: (threadId: string) => void,
  ) => Promise<SubmittedTurn>;
}

const UNSENT = "The message was not sent";

export type ChatAccess = Pick<OperationAccess, "createThreadStreamSession" | "listThreadMessages">;

/**
 * One conversation at a time: each message submits a run on the conversation's thread, and the
 * thread's transcript streams the reply. Callers render it only for a caller who may list runs.
 */
export function ChatPanel({
  access,
  onReset,
  resetLabel,
  scope,
  target,
}: Readonly<{
  access: ChatAccess;
  onReset?: () => void;
  resetLabel: string;
  scope: EnvironmentScope;
  target: ChatTarget;
}>) {
  const queryClient = useQueryClient();
  const [session, dispatch] = useReducer(chatReducer, NEW_CHAT);
  const [text, setText] = useState("");
  const [signedOut, setSignedOut] = useState<UnauthenticatedError>();
  if (signedOut) throw signedOut;
  const { phase, threadId } = session;
  const message = parseChatMessage(text);
  const ready = canSend(phase) && message.ok;

  const send = async (content: string) => {
    const attempt = nextAttempt(phase, content, () => crypto.randomUUID());
    dispatch({ attempt, type: "submit" });
    try {
      const turn = await target.submit(attempt, threadId, (opened) =>
        dispatch({ threadId: opened, type: "thread-opened" }),
      );
      setText("");
      // A new run on a settled thread turns its stream back on once the runs show it in flight.
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: threadRunPagesQuery(scope, turn.threadId).queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: transcriptPagesQuery(scope, turn.threadId).queryKey,
        }),
      ]);
      dispatch({ run: turn.run, threadId: turn.threadId, type: "submitted" });
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        setSignedOut(error);
        return;
      }
      const { description, title } = describeProblem(
        error instanceof Error ? error : new Error(String(error)),
        UNSENT,
      );
      // The callout's title already says the message was not sent.
      const parts = title === UNSENT ? [description ?? title] : [title, description];
      dispatch({ reason: parts.filter(Boolean).join(". "), type: "submit-failed" });
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) void send(message.content);
  };

  const reset = () => {
    dispatch({ type: "reset" });
    setText("");
    onReset?.();
  };

  const runId = currentRunId(phase);
  return (
    <div className="flex flex-col gap-6">
      {threadId ? (
        <>
          <SectionBoundary resetKey={threadId}>
            <ThreadActivity
              canStream={access.createThreadStreamSession}
              focusRunId={undefined}
              scope={scope}
              showRuns={false}
              showTranscript={access.listThreadMessages}
              threadId={threadId}
            />
          </SectionBoundary>
          {runId ? (
            <RunWatcher dispatch={dispatch} runId={runId} scope={scope} threadId={threadId} />
          ) : null}
        </>
      ) : (
        <Text>Send a message to start a conversation.</Text>
      )}
      <PhaseNotice phase={phase} scope={scope} />
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <Field>
          <Label>Message</Label>
          <Textarea
            aria-invalid={!message.ok && message.message !== undefined}
            name="message"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Enter sends, Shift+Enter adds a line"
            rows={3}
            value={text}
          />
          {!message.ok && message.message ? (
            <Text className="text-destructive">{message.message}</Text>
          ) : null}
        </Field>
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!ready} type="submit">
            {phase.kind === "submitting" ? <Spinner /> : null}
            Send
          </Button>
          <Button
            disabled={phase.kind === "submitting" || (threadId === undefined && !onReset)}
            onClick={reset}
            type="button"
            variant="outline"
          >
            {resetLabel}
          </Button>
          {threadId ? (
            <TextLink
              className="ml-auto text-sm/6"
              href={`${environmentPath(scope)}/threads/${threadId}`}
            >
              Open the thread
            </TextLink>
          ) : null}
        </div>
      </form>
    </div>
  );
}

/**
 * Follows the current run's status through the thread's runs, which the thread stream refreshes
 * on each run event while a run is in flight.
 */
function RunWatcher({
  dispatch,
  runId,
  scope,
  threadId,
}: Readonly<{
  dispatch: (event: ChatEvent) => void;
  runId: string;
  scope: EnvironmentScope;
  threadId: string;
}>) {
  const { data: run } = useInfiniteQuery({
    ...threadRunPagesQuery(scope, threadId),
    select: (data) => data.pages.flatMap((page) => page.items).find((item) => item.id === runId),
  });
  const status = run?.status;
  const error = run ? runErrorText(run.error) : undefined;
  useEffect(() => {
    if (status) dispatch({ run: { error, id: runId, status }, type: "run-changed" });
  }, [dispatch, error, runId, status]);
  return null;
}

function PhaseNotice({ phase, scope }: Readonly<{ phase: ChatPhase; scope: EnvironmentScope }>) {
  const runLink = (runId: string, label: ReactNode) => (
    <TextLink href={`${environmentPath(scope)}/runs/${runId}`}>{label}</TextLink>
  );
  switch (phase.kind) {
    case "idle":
    case "completed":
      return null;
    case "submitting":
      return (
        <Text className="flex items-center gap-2">
          <Spinner /> Sending…
        </Text>
      );
    case "streaming":
      return (
        <Text className="flex items-center gap-2" role="status">
          <Spinner /> The agent is responding.
        </Text>
      );
    case "waiting-for-approval":
      return (
        <Callout variant="warning">
          <CalloutTitle>The run waits for an approval</CalloutTitle>
          <CalloutDescription>
            A tool call needs approval before the run continues.{" "}
            {runLink(phase.runId, "Approve or reject it on the run")}.
          </CalloutDescription>
        </Callout>
      );
    case "waiting-for-tool":
      return (
        <Callout variant="warning">
          <CalloutTitle>The run waits for a tool result</CalloutTitle>
          <CalloutDescription>
            A client-executed tool needs its result before the run continues.{" "}
            {runLink(phase.runId, "Submit the result on the run")}.
          </CalloutDescription>
        </Callout>
      );
    case "failed":
      return (
        <Callout variant="destructive">
          <CalloutTitle>{phase.runId ? "The run failed" : UNSENT}</CalloutTitle>
          <CalloutDescription>
            <p>{phase.reason}</p>
            {phase.runId ? <p>{runLink(phase.runId, "Open the run")}.</p> : null}
            {phase.attempt ? <p>Sending the same message again repeats the same request.</p> : null}
          </CalloutDescription>
        </Callout>
      );
  }
}
