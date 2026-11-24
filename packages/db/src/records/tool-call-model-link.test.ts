import { expect, test } from "bun:test";
import { Schema } from "effect";
import { ToolCallRecord } from "./conversations.ts";
import { withCanonicalRecordKeys } from "./index.ts";

const toolCall = {
  createdAt: "2026-07-22T00:00:00.000Z",
  effect: "read",
  environmentId: "01ARZ3NDEKTSV4RRFFQ69G5FA4",
  id: "01ARZ3NDEKTSV4RRFFQ69G5FA8",
  inputSummary: "Model requested provider.read.",
  organizationId: "01ARZ3NDEKTSV4RRFFQ69G5FA5",
  projectId: "01ARZ3NDEKTSV4RRFFQ69G5FA6",
  requiredScopes: [],
  runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  status: "succeeded",
  threadId: "01ARZ3NDEKTSV4RRFFQ69G5FA7",
  toolName: "provider.read",
  updatedAt: "2026-07-22T00:00:01.000Z",
  version: 0,
} as const;

const decode = (data: Readonly<Record<string, unknown>>) =>
  Schema.decodeUnknownSync(ToolCallRecord)(
    withCanonicalRecordKeys({ data, itemType: "tool-call" }),
  );

test("tool calls name both the requesting model attempt and generation, or neither", () => {
  const modelAttemptId =
    "01ARZ3NDEKTSV4RRFFQ69G5FAV:execution:1:assistant:2:run-attempt:0:fallback:0";
  expect(decode({ ...toolCall, modelAttemptId, modelCallIndex: 2 }).data).toMatchObject({
    modelAttemptId,
    modelCallIndex: 2,
  });
  expect(decode(toolCall).data).not.toHaveProperty("modelCallIndex");
  expect(() => decode({ ...toolCall, modelAttemptId })).toThrow(
    "modelAttemptId and modelCallIndex must be present together",
  );
  expect(() => decode({ ...toolCall, modelCallIndex: 0 })).toThrow(
    "modelAttemptId and modelCallIndex must be present together",
  );
  expect(() => decode({ ...toolCall, modelAttemptId, modelCallIndex: -1 })).toThrow();
  expect(() => decode({ ...toolCall, modelAttemptId: "", modelCallIndex: 0 })).toThrow();
});
