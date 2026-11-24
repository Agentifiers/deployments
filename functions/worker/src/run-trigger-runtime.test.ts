import { describe, expect, it } from "bun:test";
import { runtimeModelToolNamesForTrigger } from "./run-trigger-runtime.ts";

describe("run trigger runtime context", () => {
  it("removes only schedule creation tools from due schedule model choices", () => {
    expect(
      runtimeModelToolNamesForTrigger(
        [
          "agent.schedule.list",
          "agent.schedule.create",
          "agent.brain.search",
          "agent.schedule.remind",
          "agent.schedule.archive",
        ],
        "schedule",
      ),
    ).toEqual(["agent.schedule.list", "agent.brain.search", "agent.schedule.archive"]);
  });

  it("leaves model tool choices unchanged for interactive and heartbeat runs", () => {
    const tools = ["agent.brain.search", "agent.schedule.remind"];
    expect(runtimeModelToolNamesForTrigger(tools, "chat")).toBe(tools);
    expect(runtimeModelToolNamesForTrigger(tools, "heartbeat")).toBe(tools);
  });
});
