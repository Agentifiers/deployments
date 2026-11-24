import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, useState, type ReactNode } from "react";
import { DEFAULT_CONSOLE_EDITION, type ConsoleRouterContext } from "../../edition.ts";
import * as runLogQueries from "../../data/runtime-log-queries.ts";
import type { RunLogFilters } from "../../runs/run-logs.ts";
import type { Run } from "../../server/runtime-data.ts";
import type { RunLogPage } from "../../server/runtime-log-data.ts";
import type { ClientView } from "@/components/ui/render-client";
import { buttons, renderWith } from "../apps/app-fixtures.tsx";
import { RunLogs } from "./run-logs.tsx";

const scope = {
  environmentId: "01K000000000000000000000E1",
  organizationId: "01K000000000000000000000G1",
  projectId: "01K000000000000000000000J1",
};
const RUN = "01K000000000000000000000R1";
const THREAD = "01K000000000000000000000T1";
const TOOL_CALL = "01K000000000000000000000C1";
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const TOOL_SPAN = "00f067aa0ba902b7";

type Line = RunLogPage["logs"][number];

const line = (id: string, overrides: Partial<Line>): Line => ({
  attempt: 1,
  id,
  level: "info",
  message: "",
  runId: RUN,
  source: "runtime",
  threadId: THREAD,
  time: "2026-11-02T12:00:00.000Z",
  traceId: TRACE,
  ...overrides,
});

const FIRST_PAGE: RunLogPage = {
  caughtUp: true,
  logs: [
    line("1-0-0", {
      attributes: { agentDeploymentId: "01K000000000000000000000D1", event: "run.started" },
      message: "Agent run started.",
      spanId: "a3ce929d0e0e4736",
    }),
    line("1-0-1", {
      attributes: { event: "model.generation.started", modelId: "provider/model-large" },
      message: "Generating a response.",
      source: "model",
    }),
    line("1-0-2", {
      attributes: { event: "tool.running", toolName: "orders.lookup" },
      message: "Running tool orders.lookup.",
      source: "tool",
      spanId: TOOL_SPAN,
      toolCallId: TOOL_CALL,
    }),
    line("1-0-3", {
      message: "looking up ord_1 with [redacted secret]",
      source: "hosted-code",
      spanId: TOOL_SPAN,
      toolCallId: TOOL_CALL,
    }),
    line("1-0-4", {
      attributes: { durationMs: 412, exitCode: 1, toolName: "orders.lookup" },
      level: "error",
      message: "Hosted code tool orders.lookup exited 1 in 412 ms.",
      source: "hosted-code",
      spanId: TOOL_SPAN,
      toolCallId: TOOL_CALL,
    }),
  ],
  nextCursor: "cursor-after-first-page",
};

const requests: Record<string, unknown>[] = [];
let respond: (data: Record<string, unknown>) => RunLogPage = () => FIRST_PAGE;
spyOn(runLogQueries, "fetchRunLogPageFn").mockImplementation((({
  data,
}: {
  data: Record<string, unknown>;
}) => {
  requests.push(data);
  return Promise.resolve(respond(data));
}) as unknown as typeof runLogQueries.fetchRunLogPageFn);
afterEach(() => {
  requests.length = 0;
  respond = () => FIRST_PAGE;
});
afterAll(() => {
  mock.restore();
});

function Panel({
  inFlight,
  initial = {},
}: Readonly<{ inFlight: boolean; initial?: RunLogFilters }>) {
  const [filters, setFilters] = useState<RunLogFilters>(initial);
  return (
    <RunLogs
      filters={filters}
      inFlight={inFlight}
      onFiltersChange={setFilters}
      run={{ id: RUN, traceId: TRACE } as Pick<Run, "id" | "traceId">}
      scope={scope}
      toolName="orders.lookup"
    />
  );
}

async function inRouter(ui: ReactNode, run: (view: ClientView) => Promise<void>) {
  const queryClient = new QueryClient();
  const root = createRootRouteWithContext<ConsoleRouterContext>()({ component: () => ui });
  const router = createRouter({
    context: { edition: DEFAULT_CONSOLE_EDITION, queryClient },
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: root,
  });
  await router.load();
  await renderWith(queryClient, <RouterProvider router={router} />, run);
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const lineTexts = (view: ClientView) =>
  [...view.document.querySelectorAll('[aria-label="Runtime log lines"] > li')].map(
    (node) => node.textContent ?? "",
  );

async function selectOption(view: ClientView, label: string, value: string) {
  const select = view.document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`);
  const window = view.document.defaultView;
  if (!select || !window) throw new Error(`no ${label} select`);
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  await settle();
}

describe("Run runtime logs", () => {
  test("shows each line with level, source, attributes, and a link to its span", async () => {
    await inRouter(<Panel inFlight={false} />, async (view) => {
      await settle();
      const texts = lineTexts(view);
      expect(texts).toHaveLength(5);
      expect(texts[1]).toContain("model");
      expect(texts[1]).toContain("modelId=provider/model-large");
      expect(texts[4]).toContain("error");
      expect(texts[4]).toContain("Hosted code tool orders.lookup exited 1 in 412 ms.");
      expect(texts[3]).toContain("[redacted secret]");
      const spanLinks = [...view.document.querySelectorAll("a")]
        .filter((anchor) => anchor.textContent === "View span")
        .map((anchor) => anchor.getAttribute("href"));
      expect(spanLinks).toContain(
        `/o/${scope.organizationId}/p/${scope.projectId}/e/${scope.environmentId}/traces/${TRACE}?span=${TOOL_SPAN}`,
      );
      expect(buttons(view, "Pause following")).toEqual([]);
    });
  });

  test("passes the level and source filters to the API", async () => {
    await inRouter(<Panel inFlight={false} />, async (view) => {
      await settle();
      respond = () => ({ caughtUp: true, logs: [FIRST_PAGE.logs[4]!], nextCursor: "c" });
      await selectOption(view, "Level", "warn");
      await selectOption(view, "Source", "hosted-code");
      expect(requests.at(-1)).toMatchObject({
        filters: { level: "warn", source: "hosted-code" },
        runId: RUN,
        scope,
      });
      expect(lineTexts(view)).toHaveLength(1);
    });
  });

  test("narrows to one tool call's lines until its chip is cleared", async () => {
    await inRouter(<Panel initial={{ toolCallId: TOOL_CALL }} inFlight={false} />, async (view) => {
      await settle();
      expect(requests[0]).toMatchObject({ filters: { toolCallId: TOOL_CALL } });
      const chip = [...view.document.querySelectorAll("button")].find((node) =>
        node.textContent?.startsWith("Tool call"),
      );
      expect(chip?.textContent).toContain("orders.lookup");
      await act(async () => {
        await view.click(chip);
      });
      await settle();
      expect(requests.at(-1)).toMatchObject({ filters: {} });
    });
  });

  test("says when filters match nothing and when a finished run kept no lines", async () => {
    respond = () => ({ caughtUp: true, logs: [], nextCursor: "c" });
    await inRouter(<Panel inFlight={false} />, async (view) => {
      await settle();
      expect(view.document.body.textContent).toContain("The runtime kept no log lines");
      await selectOption(view, "Level", "error");
      expect(view.document.body.textContent).toContain("No lines match these filters.");
    });
  });

  test("follows an in-flight run by asking for lines after the newest one", async () => {
    const timers: { readonly delay: number; readonly run: () => void }[] = [];
    const realSetTimeout = globalThis.setTimeout;
    await inRouter(<Panel inFlight />, async (view) => {
      await settle();
      expect(buttons(view, "Pause following")).toHaveLength(1);
      respond = ({ cursor }) =>
        cursor === "cursor-after-first-page"
          ? {
              caughtUp: true,
              logs: [line("1-1-0", { message: "Tool orders.lookup failed.", level: "error" })],
              nextCursor: "cursor-after-follow",
            }
          : FIRST_PAGE;
      Object.assign(globalThis, {
        setTimeout: (run: () => void, delay: number) => {
          if (delay === 5_000) {
            timers.push({ delay, run });
            return 0;
          }
          return realSetTimeout(run, delay);
        },
      });
      try {
        await act(async () => {
          await view.click(buttons(view, "Pause following")[0]);
        });
        await act(async () => {
          await view.click(buttons(view, "Follow the run")[0]);
        });
        await settle();
        expect(timers.length).toBeGreaterThan(0);
        await act(async () => {
          timers.at(-1)?.run();
        });
        await settle();
      } finally {
        Object.assign(globalThis, { setTimeout: realSetTimeout });
      }
      expect(requests.at(-1)).toMatchObject({ cursor: "cursor-after-first-page", runId: RUN });
      expect(lineTexts(view).at(-1)).toContain("Tool orders.lookup failed.");
    });
  });
});
