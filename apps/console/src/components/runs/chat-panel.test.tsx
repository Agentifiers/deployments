import { describe, expect, test } from "bun:test";
import { QueryClient, type InfiniteData } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { threadRunPagesQuery, transcriptPagesQuery } from "../../data/runtime-queries.ts";
import type { ChatAttempt } from "../../runs/chat-session.ts";
import type { RunStatus } from "../../runs/run-state.ts";
import type { SubmittedTurn } from "../../server/chat-actions.ts";
import type { LabeledPage, Page } from "../../server/list-pages.ts";
import type { Run, TranscriptMessage } from "../../server/runtime-data.ts";
import type { ClientView } from "@/components/ui/render-client";
import { renderWith, scope } from "../apps/app-fixtures.tsx";
import { ChatPanel, type ChatTarget } from "./chat-panel.tsx";

const THREAD = "01K0000000000000000000000T";
const RUN = "01K0000000000000000000000R";
const AT = "2026-10-09T12:00:00.000Z";

function run(status: RunStatus, error?: Record<string, string>): Run {
  return {
    attempt: 1,
    checkpointCount: 0,
    createdAt: AT,
    environmentId: scope.environmentId,
    executionPurpose: "customer",
    executor: "worker",
    id: RUN,
    object: "run",
    organizationId: scope.organizationId,
    priority: 0,
    projectId: scope.projectId,
    spanId: "0000000000000001",
    status,
    threadId: THREAD,
    traceId: "00000000000000000000000000000001",
    trigger: "api",
    updatedAt: AT,
    version: 1,
    ...(error ? { error } : {}),
  } as Run;
}

function seedRuns(queryClient: QueryClient, runs: readonly Run[]) {
  const data: InfiniteData<LabeledPage<Run>, string | undefined> = {
    pageParams: [undefined],
    pages: [{ items: [...runs], releases: [] }],
  };
  queryClient.setQueryData(threadRunPagesQuery(scope, THREAD).queryKey, data);
}

function seedTranscript(queryClient: QueryClient, messages: readonly TranscriptMessage[]) {
  const data: InfiniteData<Page<TranscriptMessage>, string | undefined> = {
    pageParams: [undefined],
    pages: [{ items: [...messages] }],
  };
  queryClient.setQueryData(transcriptPagesQuery(scope, THREAD).queryKey, data);
}

const message = (role: "assistant" | "user", text: string, sequence: number) => ({
  attachedFileCount: 0,
  content: { kind: "text" as const, text },
  createdAt: AT,
  id: `01K00000000000000000000M${sequence}0`,
  role,
  runId: RUN,
  sequence,
});

async function page(ui: React.ReactNode) {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => ui }),
  });
  await router.load();
  return <RouterProvider router={router} />;
}

const status = (view: ClientView) =>
  [...view.document.querySelectorAll("[role=status], [role=alert]")]
    .map((node) => node.textContent?.trim())
    .filter(Boolean)
    .join(" | ");

const sendButton = (view: ClientView) =>
  [...view.document.querySelectorAll("button")].find((node) => node.textContent === "Send");

async function typeMessage(view: ClientView, text: string) {
  const area = view.document.querySelector<HTMLTextAreaElement>('textarea[name="message"]');
  const props = area
    ? Object.entries(area).find(([key]) => key.startsWith("__reactProps$"))?.[1]
    : undefined;
  if (!area || typeof props !== "object" || props === null || !("onChange" in props)) {
    throw new Error("no message box");
  }
  const { onChange } = props as { onChange: (event: unknown) => void };
  await act(async () => {
    area.value = text;
    onChange({ currentTarget: area, nativeEvent: new Event("input"), target: area });
  });
}

async function settle(view: ClientView) {
  await act(
    () => new Promise<void>((resolve) => view.document.defaultView?.setTimeout(resolve, 50)),
  );
}

describe("ChatPanel", () => {
  test("follows the run from streaming to waiting to completed, then sends the next turn on the same thread", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    seedRuns(queryClient, []);
    seedTranscript(queryClient, []);
    const sent: { attempt: ChatAttempt; threadId: string | undefined }[] = [];
    const target: ChatTarget = {
      async submit(attempt, threadId, onThreadOpened) {
        sent.push({ attempt, threadId });
        if (threadId === undefined) onThreadOpened(THREAD);
        seedRuns(queryClient, [run("queued")]);
        return { run: { id: RUN, status: "queued" }, threadId: THREAD } satisfies SubmittedTurn;
      },
    };
    const seen: string[] = [];
    await renderWith(
      queryClient,
      await page(
        <ChatPanel
          access={{ createThreadStreamSession: false, listThreadMessages: true }}
          resetLabel="New conversation"
          scope={scope}
          target={target}
        />,
      ),
      async (view) => {
        expect(sendButton(view)?.disabled).toBe(true);
        await typeMessage(view, "What is two plus two?");
        await view.click(sendButton(view));
        await settle(view);
        seen.push(status(view));
        expect(sendButton(view)?.disabled).toBe(true);

        await act(async () => seedRuns(queryClient, [run("waiting-for-approval")]));
        await settle(view);
        seen.push(status(view));
        const approvalLink = view.document.querySelector(`a[href$="/runs/${RUN}"]`);
        expect(approvalLink?.textContent).toBe("Approve or reject it on the run");

        await act(async () => {
          seedTranscript(queryClient, [
            message("user", "What is two plus two?", 1),
            message("assistant", "Four.", 2),
          ]);
          seedRuns(queryClient, [run("completed")]);
        });
        await settle(view);
        seen.push(status(view));
        expect(
          [...view.document.querySelectorAll("ol li p")].map((node) => node.textContent),
        ).toEqual(["What is two plus two?", "Four."]);
        expect(sendButton(view)?.disabled).toBe(true);

        await typeMessage(view, "And three plus three?");
        expect(sendButton(view)?.disabled).toBe(false);
        await view.click(sendButton(view));
        await settle(view);
      },
    );
    expect(seen).toEqual([
      "The agent is responding.",
      "The run waits for an approvalA tool call needs approval before the run continues. Approve or reject it on the run.",
      "",
    ]);
    expect(sent.map(({ attempt, threadId }) => [attempt.content, threadId])).toEqual([
      ["What is two plus two?", undefined],
      ["And three plus three?", THREAD],
    ]);
    expect(sent[0]?.attempt.idempotencyKey).not.toBe(sent[1]?.attempt.idempotencyKey);
  });

  test("a failed run shows its error and a failed submission resends under the same key", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    seedRuns(queryClient, []);
    seedTranscript(queryClient, []);
    const keys: string[] = [];
    let fail = true;
    const target: ChatTarget = {
      async submit(attempt, _threadId, onThreadOpened) {
        keys.push(attempt.idempotencyKey);
        if (fail) throw new Error("network down");
        onThreadOpened(THREAD);
        seedRuns(queryClient, [run("running")]);
        return { run: { id: RUN, status: "running" }, threadId: THREAD };
      },
    };
    const seen: string[] = [];
    await renderWith(
      queryClient,
      await page(
        <ChatPanel
          access={{ createThreadStreamSession: false, listThreadMessages: true }}
          resetLabel="New conversation"
          scope={scope}
          target={target}
        />,
      ),
      async (view) => {
        await typeMessage(view, "Hi");
        await view.click(sendButton(view));
        await settle(view);
        seen.push(status(view));
        fail = false;
        await view.click(sendButton(view));
        await settle(view);
        await act(async () =>
          seedRuns(queryClient, [
            run("failed", { code: "model_error", message: "Upstream timeout" }),
          ]),
        );
        await settle(view);
        seen.push(status(view));
      },
    );
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(seen).toEqual([
      "The message was not sentnetwork downSending the same message again repeats the same request.",
      "The run failedmodel_error: Upstream timeoutOpen the run.",
    ]);
  });
});
