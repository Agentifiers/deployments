import { createServerFn } from "@tanstack/react-start";
import { oneOf } from "../observability/range.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  archiveDefinition,
  archiveRelease,
  cancelExecution,
  createDefinition,
  publishRelease,
  resolveApproval,
  startExecution,
  updateDefinition,
} from "../server/workflow-actions.ts";
import type { ApprovalDecision, ApprovalTarget } from "../workflows/model.ts";
import {
  fields,
  keyedInput,
  scopedInput,
  type KeyedInput,
  type ScopedInput,
} from "./server-input.ts";

const DECISIONS = ["approved", "rejected"] as const satisfies readonly ApprovalDecision[];

function versionField<const Name extends string>(input: unknown, name: Name) {
  const value = fields(input)[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return { [name]: value } as Readonly<Record<Name, number>>;
}

function documentField(input: unknown) {
  const { document } = fields(input);
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new TypeError("document must be a JSON object.");
  }
  return { document };
}

interface DefinitionInput extends KeyedInput {
  readonly definitionId: string;
}

export const createDefinitionFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly document: object }) => ({
    ...keyedInput(input),
    ...documentField(input),
  }))
  .handler(async ({ data }) =>
    createDefinition({ ...data, accessToken: await requireAccessToken() }),
  );

export const updateDefinitionFn = createServerFn({ method: "POST" })
  .validator(
    (input: DefinitionInput & { readonly document: object; readonly expectedVersion: number }) => ({
      ...keyedInput(input, ["definitionId"]),
      ...documentField(input),
      ...versionField(input, "expectedVersion"),
    }),
  )
  .handler(async ({ data }) =>
    updateDefinition({ ...data, accessToken: await requireAccessToken() }),
  );

export const archiveDefinitionFn = createServerFn({ method: "POST" })
  .validator((input: DefinitionInput & { readonly expectedVersion: number }) => ({
    ...keyedInput(input, ["definitionId"]),
    ...versionField(input, "expectedVersion"),
  }))
  .handler(async ({ data }) =>
    archiveDefinition({ ...data, accessToken: await requireAccessToken() }),
  );

export const publishReleaseFn = createServerFn({ method: "POST" })
  .validator((input: DefinitionInput & { readonly expectedDefinitionVersion: number }) => ({
    ...keyedInput(input, ["definitionId"]),
    ...versionField(input, "expectedDefinitionVersion"),
  }))
  .handler(async ({ data }) =>
    publishRelease({ ...data, accessToken: await requireAccessToken() }),
  );

export const archiveReleaseFn = createServerFn({ method: "POST" })
  .validator(
    (input: KeyedInput & { readonly expectedVersion: number; readonly releaseId: string }) => ({
      ...keyedInput(input, ["releaseId"]),
      ...versionField(input, "expectedVersion"),
    }),
  )
  .handler(async ({ data }) =>
    archiveRelease({ ...data, accessToken: await requireAccessToken() }),
  );

export const startExecutionFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly input?: object; readonly releaseId: string }) => {
    const executionInput = fields(input).input;
    if (
      executionInput !== undefined &&
      (typeof executionInput !== "object" || executionInput === null)
    ) {
      throw new TypeError("input must be a JSON object.");
    }
    return { ...keyedInput(input, ["releaseId"]), input: executionInput };
  })
  .handler(async ({ data }) =>
    startExecution({ ...data, accessToken: await requireAccessToken() }),
  );

export const cancelExecutionFn = createServerFn({ method: "POST" })
  .validator(
    (input: ScopedInput & { readonly executionId: string; readonly expectedVersion: number }) => ({
      ...scopedInput(input, ["executionId"]),
      ...versionField(input, "expectedVersion"),
    }),
  )
  .handler(async ({ data }) =>
    cancelExecution({ ...data, accessToken: await requireAccessToken() }),
  );

export const resolveApprovalFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & ApprovalTarget & { readonly decision: ApprovalDecision }) => {
    const decision = oneOf(DECISIONS, fields(input).decision);
    if (!decision) throw new TypeError("decision must be approved or rejected.");
    return { ...scopedInput(input, ["approvalId", "executionId"]), decision };
  })
  .handler(async ({ data }) =>
    resolveApproval({ ...data, accessToken: await requireAccessToken() }),
  );
