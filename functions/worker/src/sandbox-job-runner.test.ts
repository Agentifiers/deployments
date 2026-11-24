import { describe, expect, test } from "bun:test";
import type { ManagedSandbox, SandboxManagerService } from "@deployments-ai/sandbox-hosts";
import { Effect } from "effect";
import { runSandboxJob, type SandboxJob } from "./sandbox-job-runner.ts";

type Status = { readonly state: string; readonly detail?: string };

function harness(options: {
  readonly exitCode?: number;
  readonly start?: Status;
  readonly statuses: readonly Status[];
}) {
  const events: string[] = [];
  const statuses = [...options.statuses];
  const manager = {
    exec: (input: { readonly command: readonly string[] }) =>
      Effect.sync(() => {
        events.push(input.command.join(" "));
        const action = input.command.at(-2);
        const value =
          action === "start" ? (options.start ?? { state: "started" }) : statuses.shift();
        return {
          durationMs: 1,
          exitCode: options.exitCode ?? 0,
          stderr: "",
          stdout: `${JSON.stringify(value)}\n`,
        };
      }),
    upload: (input: { readonly path: string }) =>
      Effect.sync(() => {
        events.push(`upload ${input.path}`);
      }),
  } as unknown as Pick<SandboxManagerService, "exec" | "upload">;
  return { events, manager };
}

const job: SandboxJob<Status> = {
  control: ["driver"],
  decodeStatus: (value) => value as Status,
  label: "Test",
  startArgument: "/jobs/spec.json",
  statusArgument: "/jobs",
  uploads: [
    { content: "script", path: "/jobs/driver" },
    { content: "{}", path: "/jobs/spec.json" },
  ],
};

function context(manager: Pick<SandboxManagerService, "exec" | "upload">, now = () => 0) {
  return {
    deadline: 1,
    manager,
    now,
    sandbox: {} as ManagedSandbox,
    signal: undefined,
  };
}

describe("sandbox job runner", () => {
  test("uploads files in order, starts the job, and polls until it settles", async () => {
    const { events, manager } = harness({
      statuses: [{ state: "running" }, { detail: "ok", state: "done" }],
    });

    expect(runSandboxJob(context(manager), job)).resolves.toEqual({
      detail: "ok",
      state: "done",
    });
    expect(events).toEqual([
      "upload /jobs/driver",
      "upload /jobs/spec.json",
      "driver start /jobs/spec.json",
      "driver status /jobs",
      "driver status /jobs",
    ]);
  });

  test("reports a running job past its deadline as a timeout", async () => {
    const { events, manager } = harness({ statuses: [{ state: "running" }] });

    expect(
      runSandboxJob(
        context(manager, () => 1),
        job,
      ),
    ).resolves.toEqual({
      state: "timeout",
    });
    expect(events.filter((event) => event.includes("status"))).toHaveLength(1);
  });

  test("rejects jobs that do not start, vanish, or whose control program fails", async () => {
    expect(
      runSandboxJob(context(harness({ start: { state: "running" }, statuses: [] }).manager), job),
    ).rejects.toThrow("Test job did not start.");
    expect(
      runSandboxJob(context(harness({ statuses: [{ state: "missing" }] }).manager), job),
    ).rejects.toThrow("Test job status is unavailable.");
    expect(
      runSandboxJob(context(harness({ exitCode: 2, statuses: [] }).manager), job),
    ).rejects.toThrow("Test control exited with status 2.");
  });
});
