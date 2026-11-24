import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CreateManagedSkillSourceRequest,
  PublishManagedSkillReleaseRequest,
  UpdateManagedSkillSourceRequest,
} from "./managed-skills.ts";
import {
  MAX_WORKFLOW_EXECUTION_INPUT_BYTES,
  StartWorkflowExecutionRequest,
  WorkflowDefinitionDocumentV1,
} from "./workflows.ts";

describe("workflow definition contract", () => {
  const decode = Schema.decodeUnknownSync(WorkflowDefinitionDocumentV1);

  test("bounds workflow execution input with durable-record headroom", () => {
    const decodeStart = Schema.decodeUnknownSync(StartWorkflowExecutionRequest);
    expect(() => decodeStart({ input: { value: "x".repeat(60 * 1024) } })).not.toThrow();
    expect(() =>
      decodeStart({ input: { value: "x".repeat(MAX_WORKFLOW_EXECUTION_INPUT_BYTES) } }),
    ).toThrow(/must not exceed/u);
  });

  test("accepts deterministic control-flow steps and validates every reference", () => {
    const definition = {
      entryStepId: "prepare",
      name: "Release with approval",
      schemaVersion: 1,
      slug: "release-with-approval",
      steps: [
        {
          agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          id: "prepare",
          next: "approve",
          toolName: "release.prepare",
          type: "tool",
        },
        {
          id: "approve",
          onApproved: "notify",
          onExpired: "escalate",
          onRejected: "stop",
          prompt: "Approve the prepared release?",
          type: "approval",
        },
        {
          channel: "slack",
          id: "notify",
          message: "Release approved",
          next: "stop",
          target: "#releases",
          type: "notification",
        },
        {
          id: "escalate",
          message: "Approval expired",
          next: "stop",
          target: "release-manager",
          type: "escalation",
        },
        { id: "stop", type: "end" },
      ],
    } as const;

    const decoded = decode(definition);
    expect(String(decoded.slug)).toBe(definition.slug);
    expect(decoded.steps).toHaveLength(definition.steps.length);
    expect(() =>
      decode({
        ...definition,
        steps: [...definition.steps.slice(0, -1), { id: "escalate", type: "end" }],
      }),
    ).toThrow();
    expect(() =>
      decode({
        ...definition,
        steps: [
          {
            agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            id: "prepare",
            next: "missing",
            toolName: "release.prepare",
            type: "tool",
          },
        ],
      }),
    ).toThrow();
    for (const path of ["references/../secret.md", "references/./checklist.md"]) {
      expect(() =>
        decode({
          expectedSourceVersion: 0,
          releaseVersion: "1.2.3",
          skills: [{ content: "# Release", key: "release", references: { [path]: "nope" } }],
        }),
      ).toThrow();
    }
  });

  test("requires the entry point to name a declared step", () => {
    expect(() =>
      decode({
        entryStepId: "missing",
        name: "Broken workflow",
        schemaVersion: 1,
        slug: "broken-workflow",
        steps: [{ id: "stop", type: "end" }],
      }),
    ).toThrow();
  });

  test("bounds the complete encoded workflow document", () => {
    expect(() =>
      decode({
        entryStepId: "step-0",
        name: "Oversized workflow",
        schemaVersion: 1,
        slug: "oversized-workflow",
        steps: [
          ...Array.from({ length: 11 }, (_, index) => ({
            id: `step-${index}`,
            message: "x".repeat(32_000),
            next: "done",
            target: "operations",
            type: "escalation",
          })),
          { id: "done", type: "end" },
        ],
      }),
    ).toThrow();
  });

  test("rejects cycles, unreachable steps, and implicit successful termination", () => {
    expect(() =>
      decode({
        entryStepId: "loop-a",
        name: "Cyclic workflow",
        schemaVersion: 1,
        slug: "cyclic-workflow",
        steps: [
          {
            agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            id: "loop-a",
            next: "loop-b",
            toolName: "one",
            type: "tool",
          },
          {
            agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            id: "loop-b",
            next: "loop-a",
            toolName: "two",
            type: "tool",
          },
        ],
      }),
    ).toThrow(/cycle/u);
    expect(() =>
      decode({
        entryStepId: "done",
        name: "Unreachable workflow",
        schemaVersion: 1,
        slug: "unreachable-workflow",
        steps: [
          { id: "done", type: "end" },
          { id: "orphan", type: "end" },
        ],
      }),
    ).toThrow(/unreachable/u);
    expect(() =>
      decode({
        entryStepId: "tool",
        name: "Implicit termination",
        schemaVersion: 1,
        slug: "implicit-termination",
        steps: [
          {
            agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            id: "tool",
            toolName: "release.prepare",
            type: "tool",
          },
        ],
      }),
    ).toThrow(/requires next/u);
  });

  test("allows branch output operands only from possible predecessor steps", () => {
    expect(() =>
      decode({
        entryStepId: "choose",
        name: "Future output",
        schemaVersion: 1,
        slug: "future-output",
        steps: [
          {
            condition: { left: { source: "step", stepId: "prepare" }, operator: "exists" },
            id: "choose",
            onFalse: "done",
            onTrue: "prepare",
            type: "branch",
          },
          {
            agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            id: "prepare",
            next: "done",
            toolName: "release.prepare",
            type: "tool",
          },
          { id: "done", type: "end" },
        ],
      }),
    ).toThrow(/can only read output from a step that can precede it/u);

    expect(() =>
      decode({
        entryStepId: "route",
        name: "Optional predecessor output",
        schemaVersion: 1,
        slug: "optional-predecessor-output",
        steps: [
          {
            condition: { left: { source: "input" }, operator: "truthy" },
            id: "route",
            onFalse: "inspect",
            onTrue: "prepare",
            type: "branch",
          },
          {
            agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            id: "prepare",
            next: "inspect",
            toolName: "release.prepare",
            type: "tool",
          },
          {
            condition: { left: { source: "step", stepId: "prepare" }, operator: "exists" },
            id: "inspect",
            onFalse: "missing",
            onTrue: "present",
            type: "branch",
          },
          { id: "present", type: "end" },
          { id: "missing", type: "end" },
        ],
      }),
    ).not.toThrow();
  });

  test("links policy-gated tools only to preceding approval steps", () => {
    const definition = {
      entryStepId: "approve",
      name: "Approved tool",
      schemaVersion: 1,
      slug: "approved-tool",
      steps: [
        {
          id: "approve",
          onApproved: "write",
          onRejected: "done",
          prompt: "Allow the write?",
          type: "approval",
        },
        {
          agentDeploymentId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          approvalStepId: "approve",
          id: "write",
          next: "done",
          toolName: "records.write",
          type: "tool",
        },
        { id: "done", type: "end" },
      ],
    } as const;
    expect(() => decode(definition)).not.toThrow();
    expect(() =>
      decode({
        ...definition,
        entryStepId: "write",
        steps: [
          { ...definition.steps[1], next: "approve" },
          { ...definition.steps[0], onApproved: "done" },
          definition.steps[2],
        ],
      }),
    ).toThrow(/approval step must be able to precede/u);
  });
});

describe("managed skill contract", () => {
  test("accepts bounded reference files below the references directory", () => {
    const decode = Schema.decodeUnknownSync(PublishManagedSkillReleaseRequest);
    expect(() =>
      decode({
        expectedSourceVersion: 0,
        releaseVersion: "1.2.3",
        skills: [
          {
            content: "# Release",
            key: "release",
            references: { "references/checklist.md": "- verify\n- deploy" },
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      decode({
        expectedSourceVersion: 0,
        releaseVersion: "1.2.3",
        skills: [
          {
            content: "# Release",
            key: "release",
            references: { "../secret.md": "nope" },
          },
        ],
      }),
    ).toThrow();
  });

  test("requires safe source locations and unique materialized skill keys", () => {
    const decodeSource = Schema.decodeUnknownSync(CreateManagedSkillSourceRequest);
    expect(() =>
      decodeSource({
        key: "release-tools",
        name: "Release tools",
        repositoryUrl: "https://github.com/example/release-tools",
      }),
    ).not.toThrow();
    expect(() =>
      decodeSource({
        key: "release-tools",
        name: "Release tools",
        repositoryUrl: "http://github.com/example/release-tools",
      }),
    ).toThrow();
    expect(() =>
      decodeSource({
        key: "release-tools",
        name: "Release tools",
        repositoryUrl: "https://token@example.com/release-tools",
      }),
    ).toThrow();
    expect(() =>
      decodeSource({
        key: "release-tools",
        name: "Release tools",
        repositoryUrl: "https://github.com/example/release-tools?token=secret",
      }),
    ).toThrow();
    const decodeUpdate = Schema.decodeUnknownSync(UpdateManagedSkillSourceRequest);
    expect(() =>
      decodeUpdate({
        expectedVersion: 1,
        licenseHash: null,
        metadata: null,
        pinnedCommit: null,
        repositoryUrl: null,
      }),
    ).not.toThrow();

    const decodeRelease = Schema.decodeUnknownSync(PublishManagedSkillReleaseRequest);
    expect(() =>
      decodeRelease({
        expectedSourceVersion: 0,
        releaseVersion: "1.2.3",
        skills: [
          { content: "# Release", key: "release" },
          { content: "# Release again", key: "release" },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeRelease({
        expectedSourceVersion: 0,
        releaseVersion: "1.2.3",
        skills: [
          {
            content: "# Release",
            dependencies: ["verify", "verify"],
            key: "release",
          },
          { content: "# Verify", key: "verify" },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeRelease({
        expectedSourceVersion: 0,
        releaseVersion: "1.2.3",
        skills: [
          {
            content: "# Release",
            dependencies: Array.from({ length: 97 }, (_, index) => `dependency-${index}`),
            key: "release",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodeRelease({
        expectedSourceVersion: 0,
        releaseVersion: "latest",
        skills: [{ content: "# Release", key: "release" }],
      }),
    ).toThrow();
    expect(() =>
      decodeRelease({
        expectedSourceVersion: 0,
        releaseVersion: "1.2.3+build.4",
        skills: [{ content: "# Release", key: "release" }],
      }),
    ).not.toThrow();
    for (const releaseVersion of ["01.2.3", "1.2.3-."]) {
      expect(() =>
        decodeRelease({
          expectedSourceVersion: 0,
          releaseVersion,
          skills: [{ content: "# Release", key: "release" }],
        }),
      ).toThrow();
    }
    expect(() =>
      decodeRelease({
        expectedSourceVersion: 0,
        releaseVersion: "1.2.3",
        skills: Array.from({ length: 97 }, (_, index) => ({
          content: `# Skill ${index}`,
          key: `skill-${index}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeRelease({
        expectedSourceVersion: 0,
        releaseVersion: "1.2.3",
        skills: Array.from({ length: 12 }, (_, index) => ({
          content: "x".repeat(256 * 1024),
          key: `skill-${index}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      decodeRelease({
        expectedSourceVersion: 0,
        manifest: { payload: "x".repeat(321 * 1024) },
        releaseVersion: "1.2.3",
        skills: [{ content: "# Release", key: "release" }],
      }),
    ).toThrow();
    expect(() =>
      decodeRelease({
        expectedSourceVersion: 0,
        releaseVersion: "1.2.3",
        skills: [
          {
            content: "# Release",
            key: "release",
            metadata: { payload: "x".repeat(321 * 1024) },
          },
        ],
      }),
    ).toThrow();
  });
});
