import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { Ulid } from "../ids.ts";
import { decodePlatformRecord, tableForItemType, withCanonicalRecordKeys } from "./index.ts";
import { WorkflowReleaseRecord, workflowDefinitionContentHash } from "./workflows.ts";

const ORGANIZATION_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const PROJECT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAW");
const ENVIRONMENT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAX");
const PRINCIPAL_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAY");
const DEFINITION_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FAZ");
const RELEASE_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FB0");
const EXECUTION_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FB1");
const ATTEMPT_ID = Schema.decodeUnknownSync(Ulid)("01ARZ3NDEKTSV4RRFFQ69G5FB2");
const TIMESTAMP = "2026-07-31T12:00:00.000Z";

function execution() {
  return withCanonicalRecordKeys({
    data: {
      context: {},
      createdAt: TIMESTAMP,
      currentStepAttempt: 0,
      currentStepId: "prepare",
      environmentId: ENVIRONMENT_ID,
      id: EXECUTION_ID,
      idempotencyKey: "workflow/request-1",
      initiatedBy: { id: PRINCIPAL_ID, type: "principal" as const },
      input: { release: "2026.07.31" },
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      status: "queued" as const,
      stepTransitionCount: 0,
      updatedAt: TIMESTAMP,
      version: 0,
      workflowContentHash: `sha256:${"a".repeat(64)}`,
      workflowDefinitionId: DEFINITION_ID,
      workflowReleaseId: RELEASE_ID,
      workflowReleaseNumber: 3,
    },
    itemType: "workflow-execution" as const,
  });
}

describe("workflow execution records", () => {
  test("rejects an immutable release whose content hash does not match its definition", () => {
    const definition = {
      entryStepId: "done",
      name: "Release",
      schemaVersion: 1,
      slug: "release",
      steps: [{ id: "done", type: "end" }],
    };
    const record = withCanonicalRecordKeys({
      data: {
        contentHash: workflowDefinitionContentHash(definition),
        createdAt: TIMESTAMP,
        createdByPrincipalId: PRINCIPAL_ID,
        definition,
        environmentId: ENVIRONMENT_ID,
        id: RELEASE_ID,
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        releaseNumber: 1,
        status: "active" as const,
        version: 0,
        workflowDefinitionId: DEFINITION_ID,
      },
      itemType: "workflow-release" as const,
    });

    expect(() => Schema.decodeUnknownSync(WorkflowReleaseRecord)(record)).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(WorkflowReleaseRecord)({
        ...record,
        data: { ...record.data, contentHash: `sha256:${"0".repeat(64)}` },
      }),
    ).toThrow(/contentHash/u);
  });

  test("registers execution records in the execution table", () => {
    expect(tableForItemType("workflow-execution")).toBe("execution");
    expect(tableForItemType("workflow-execution-lookup")).toBe("execution");
    expect(tableForItemType("workflow-step-attempt")).toBe("execution");
  });

  test("stores the aggregate and attempts in one workflow partition", () => {
    const aggregate = execution();
    const attempt = withCanonicalRecordKeys({
      data: {
        attempt: 0,
        createdAt: TIMESTAMP,
        environmentId: ENVIRONMENT_ID,
        id: ATTEMPT_ID,
        input: { release: "2026.07.31" },
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        status: "queued" as const,
        stepId: "prepare",
        stepType: "tool" as const,
        updatedAt: TIMESTAMP,
        version: 0,
        workflowExecutionId: EXECUTION_ID,
      },
      itemType: "workflow-step-attempt" as const,
    });

    expect(aggregate.pk).toBe(`ORG#${ORGANIZATION_ID}#WORKFLOW-EXECUTION#${EXECUTION_ID}`);
    expect(attempt.pk).toBe(aggregate.pk);
    expect(attempt.sk).toBe(`WORKFLOW-STEP-ATTEMPT#${ATTEMPT_ID}`);
    expect(aggregate.gsi2pk).toBe(`ENV#${ENVIRONMENT_ID}`);
  });

  test("uses a bounded hash of the idempotency key for lookup identity", () => {
    const lookup = withCanonicalRecordKeys({
      data: {
        createdAt: TIMESTAMP,
        environmentId: ENVIRONMENT_ID,
        executionId: EXECUTION_ID,
        idempotencyKey: "x".repeat(512),
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      },
      itemType: "workflow-execution-lookup" as const,
    });

    expect(lookup.pk).toBe(`ORG#${ORGANIZATION_ID}#ENV#${ENVIRONMENT_ID}`);
    expect(lookup.sk).toMatch(/^WORKFLOW-EXECUTION-LOOKUP#[a-f0-9]{64}$/u);
  });

  test("decodes a complete canonical execution", async () => {
    const exit = await Effect.runPromiseExit(decodePlatformRecord(execution()));
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  test("rejects an execution without its immutable release pin", async () => {
    const value = execution();
    const exit = await Effect.runPromiseExit(
      decodePlatformRecord({
        ...value,
        data: { ...value.data, workflowContentHash: undefined },
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
