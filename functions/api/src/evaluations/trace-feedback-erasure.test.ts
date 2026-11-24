import { describe, expect, test } from "bun:test";
import {
  makeEvaluationPersistence,
  TraceRecord,
  withCanonicalRecordKeys,
} from "@deployments-ai/db";
import {
  CREATED_AT,
  REQUESTER,
  SCOPE,
  seedRecords,
  testId,
} from "@deployments-ai/db/erasure-testing";
import {
  conversation,
  conversationErasureFixture,
} from "@deployments-ai/governance/erasure-testing";
import { Schema } from "effect";
import { evaluationHarness, PRINCIPAL } from "./api.fixture.ts";

const THREAD = testId("T1");
const TRACE = "0123456789abcdef0123456789abcdef";

function conversationTrace() {
  return Schema.decodeUnknownSync(TraceRecord)(
    withCanonicalRecordKeys({
      data: {
        ...SCOPE,
        captureMode: "full-content",
        createdAt: CREATED_AT,
        finalizedAt: CREATED_AT,
        id: TRACE,
        redactionPolicyVersion: 1,
        rootRunId: testId("R1"),
        rootSpanId: "0123456789abcdef",
        runIds: [testId("R1")],
        schemaVersion: 1,
        sessionId: THREAD,
        status: "finalized",
        traceId: TRACE,
        updatedAt: CREATED_AT,
        version: 1,
      },
      itemType: "trace",
    }),
  );
}

describe("trace feedback erasure", () => {
  test("an annotation and a score posted on a conversation trace without a run are erased with the thread", async () => {
    const fixture = conversationErasureFixture();
    await seedRecords(fixture.database, [...conversation(THREAD, "1"), conversationTrace()]);
    const { call } = evaluationHarness({
      database: fixture.database,
      environment: {
        id: SCOPE.environmentId,
        organizationId: SCOPE.organizationId,
        projectId: SCOPE.projectId,
        status: "active",
      },
      identity: {
        authentication: "tenant-jwt",
        environmentIds: [SCOPE.environmentId],
        organizationIds: [SCOPE.organizationId],
        principalId: PRINCIPAL,
        projectIds: [SCOPE.projectId],
        scopes: ["observability:read", "observability:write"],
      },
    });
    const tenant = {
      "x-deployments-environment": SCOPE.environmentId,
      "x-deployments-organization": SCOPE.organizationId,
      "x-deployments-project": SCOPE.projectId,
    };
    const definition = await call("POST", "/v1/score-definitions", {
      body: { evaluator: { kind: "human" }, name: "grounded" },
      headers: tenant,
    });
    const score = await call("POST", `/v1/traces/${TRACE}/score-results`, {
      body: {
        rationale: "Quoted the customer's address.",
        scoreDefinitionId: definition.body.id,
        value: 1,
      },
      headers: tenant,
      idempotencyKey: "score-trace",
    });
    const annotation = await call("POST", `/v1/traces/${TRACE}/annotations`, {
      body: { body: "The customer asked to cancel." },
      headers: tenant,
      idempotencyKey: "annotation-trace",
    });
    expect([definition.status, score.status, annotation.status]).toEqual([201, 201, 201]);
    const persistence = makeEvaluationPersistence(fixture.database, SCOPE);
    const feedback = async () => ({
      annotations: (await persistence.listAnnotations(TRACE, {})).items.map(
        (item) => item.data.body,
      ),
      scores: (await persistence.listTraceScoreResults(TRACE, {})).items.map(
        (item) => item.data.rationale,
      ),
    });
    expect(await feedback()).toEqual({
      annotations: ["The customer asked to cancel."],
      scores: ["Quoted the customer's address."],
    });

    const request = await fixture.store.requestThreadErasure({
      requester: REQUESTER,
      scope: SCOPE,
      threadId: THREAD,
    });
    if (request.kind !== "created") throw new Error(`Erasure was not created: ${request.kind}.`);
    expect((await fixture.runToCompletion(request.operation)).status).toBe("completed");

    expect(await fixture.threadRecordTypes(THREAD)).toEqual([]);
    expect(await feedback()).toEqual({ annotations: [], scores: [] });
  });
});
