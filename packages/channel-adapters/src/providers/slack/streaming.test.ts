import { describe, expect, test } from "bun:test";
import {
  normalizeSlackStreamIdentity,
  slackAgentPlanChunks,
  slackProgressChunks,
  slackStreamStartPayload,
  slackTerminalChunks,
} from "./streaming.ts";

describe("Slack native agent streaming", () => {
  test("starts a plan surface scoped to the triggering user message", () => {
    expect(
      slackStreamStartPayload({
        channel: "C1",
        recipientTeamId: "T1",
        recipientUserId: "U1",
        threadTs: "1721609600.123456",
      }),
    ).toEqual({
      channel: "C1",
      chunks: [{ title: "Working on your request", type: "plan_update" }],
      recipient_team_id: "T1",
      recipient_user_id: "U1",
      task_display_mode: "plan",
      thread_ts: "1721609600.123456",
    });
  });

  test("adds a bounded custom agent identity to the stream start payload", () => {
    expect(
      normalizeSlackStreamIdentity({
        iconUrl: "https://cdn.example.test/agents/rex.png",
        username: " Rex ",
      }),
    ).toEqual({
      iconUrl: "https://cdn.example.test/agents/rex.png",
      username: "Rex",
    });
    expect(
      slackStreamStartPayload({
        channel: "C1",
        identity: {
          iconUrl: "https://cdn.example.test/agents/rex.png",
          username: "Rex",
        },
        recipientTeamId: "T1",
        recipientUserId: "U1",
        threadTs: "1721609600.123456",
      }),
    ).toMatchObject({
      icon_url: "https://cdn.example.test/agents/rex.png",
      username: "Rex",
    });

    expect(() =>
      slackStreamStartPayload({
        channel: "C1",
        identity: { username: "x".repeat(81) },
        recipientTeamId: "T1",
        recipientUserId: "U1",
        threadTs: "1721609600.123456",
      }),
    ).toThrow("username");
    expect(() =>
      slackStreamStartPayload({
        channel: "C1",
        identity: {
          iconEmoji: ":robot_face:",
          iconUrl: "https://cdn.example.test/agents/rex.png",
          username: "Rex",
        },
        recipientTeamId: "T1",
        recipientUserId: "U1",
        threadTs: "1721609600.123456",
      }),
    ).toThrow("one icon");
    expect(() =>
      slackStreamStartPayload({
        channel: "C1",
        identity: { iconUrl: "http://example.test/rex.png", username: "Rex" },
        recipientTeamId: "T1",
        recipientUserId: "U1",
        threadTs: "1721609600.123456",
      }),
    ).toThrow("HTTPS");
    expect(() =>
      normalizeSlackStreamIdentity({
        iconUrl: `https://cdn.example.test/${"é".repeat(400)}`,
        username: "Rex",
      }),
    ).toThrow("icon URL");
    expect(() => normalizeSlackStreamIdentity({ username: 42 })).toThrow("username");
  });

  test("maps tool progress onto stable native task cards", () => {
    const running = slackProgressChunks({
      eventType: "tool.running",
      level: "info",
      message: "Running tool github.issue.create.",
      metadata: { toolCallId: "tool-1", toolName: "github.issue.create" },
    });
    const completed = slackProgressChunks({
      eventType: "tool.completed",
      level: "info",
      message: "Tool github.issue.create completed.",
      metadata: {
        outputSummary: "Private tool result that must not be published.",
        toolCallId: "tool-1",
        toolName: "github.issue.create",
      },
    });

    expect(running).toEqual([
      {
        details: "Running tool github.issue.create.",
        id: "tool-1",
        status: "in_progress",
        title: "Use github.issue.create",
        type: "task_update",
      },
    ]);
    expect(completed).toEqual([
      {
        details: "Tool github.issue.create completed.",
        id: "tool-1",
        status: "complete",
        title: "Use github.issue.create",
        type: "task_update",
      },
    ]);
  });

  test("projects canonical plans and individual task transitions", () => {
    const task = {
      id: "produce-response",
      order: 0,
      status: "pending" as const,
      title: "Produce the response",
    };
    expect(
      slackAgentPlanChunks({
        eventType: "agent.plan.updated",
        plan: { revision: 1, tasks: [task], title: "Complete the request" },
      }),
    ).toEqual([
      { title: "Complete the request", type: "plan_update" },
      {
        id: "produce-response",
        status: "pending",
        title: "Produce the response",
        type: "task_update",
      },
    ]);
    expect(
      slackAgentPlanChunks({
        eventType: "agent.task.updated",
        plan: { revision: 2, title: "Complete the request" },
        task: { ...task, status: "skipped" },
      }),
    ).toEqual([
      {
        id: "produce-response",
        status: "complete",
        title: "Produce the response",
        type: "task_update",
      },
    ]);
  });

  test("does not spend task-card updates on policy-only events", () => {
    expect(
      slackProgressChunks({
        eventType: "tool.policy-decided",
        level: "info",
        message: "Tool policy allowed provider.read.",
        metadata: { toolCallId: "tool-1", toolName: "provider.read" },
      }),
    ).toEqual([]);
  });

  test("bounds task text and splits terminal markdown at Slack limits", () => {
    const [task] = slackProgressChunks({
      eventType: "tool.failed",
      level: "error",
      message: "x".repeat(400),
      metadata: { toolCallId: "tool-1", toolName: "y".repeat(400) },
    });
    const markdown = slackTerminalChunks({
      body: "z".repeat(24_001),
      status: "completed",
    });

    expect(task?.type).toBe("task_update");
    if (task?.type === "task_update") {
      expect(Array.from(task.details!)).toHaveLength(256);
      expect(Array.from(task.title)).toHaveLength(256);
      expect(task.status).toBe("error");
    }
    expect(markdown).toHaveLength(3);
    expect(
      markdown.map((chunk) => (chunk.type === "markdown_text" ? chunk.text.length : 0)),
    ).toEqual([12_000, 12_000, 1]);
  });

  test("bounds total terminal markdown with an explicit truncation notice", () => {
    const chunks = slackTerminalChunks({ body: "z".repeat(100_000), status: "completed" });
    expect(chunks).toHaveLength(4);
    expect(
      chunks.map((chunk) => (chunk.type === "markdown_text" ? chunk.text : "")).join(""),
    ).toEndWith("Open Deployments.ai to view the complete result._");
  });
});
