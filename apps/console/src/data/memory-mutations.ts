import type {
  CreateMemorySpaceGrantRequest,
  CreateMemorySpaceRequest,
} from "@deployments-ai/api-contract/memory";
import { createServerFn } from "@tanstack/react-start";
import {
  GRANT_PERMISSIONS,
  USEFULNESS_RATINGS,
  type GrantPermission,
  type ImportRequest,
  type LifecycleAction,
  type PolicyRequest,
  type ReviewRequest,
  type SearchRequest,
  type Usefulness,
} from "../memory/model.ts";
import { oneOf } from "../observability/range.ts";
import {
  archiveSpace,
  changeLifecycle,
  createGrant,
  createPolicy,
  createSpace,
  exportSpace,
  importMemories,
  recordFeedback,
  resolveReview,
  revokeGrant,
  searchMemories,
  updateGrant,
  updatePolicy,
} from "../server/memory-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  fields,
  keyedInput,
  requireBody,
  scopedInput,
  type KeyedInput,
  type ScopedInput,
} from "./server-input.ts";

function bodyInput(input: unknown) {
  return { ...keyedInput(input), body: requireBody(input) };
}

export const createSpaceFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly body: typeof CreateMemorySpaceRequest.Encoded }) =>
    bodyInput(input),
  )
  .handler(async ({ data }) => createSpace({ ...data, accessToken: await requireAccessToken() }));

export const archiveSpaceFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly memorySpaceId: string }) =>
    keyedInput(input, ["memorySpaceId"]),
  )
  .handler(async ({ data }) => archiveSpace({ ...data, accessToken: await requireAccessToken() }));

export const createPolicyFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly body: PolicyRequest }) => bodyInput(input))
  .handler(async ({ data }) => createPolicy({ ...data, accessToken: await requireAccessToken() }));

export const updatePolicyFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly body: PolicyRequest; readonly policyId: string }) => ({
    ...keyedInput(input, ["policyId"]),
    body: fields(requireBody(input)),
  }))
  .handler(async ({ data }) => updatePolicy({ ...data, accessToken: await requireAccessToken() }));

export const createGrantFn = createServerFn({ method: "POST" })
  .validator(
    (input: KeyedInput & { readonly body: typeof CreateMemorySpaceGrantRequest.Encoded }) =>
      bodyInput(input),
  )
  .handler(async ({ data }) => createGrant({ ...data, accessToken: await requireAccessToken() }));

export const updateGrantFn = createServerFn({ method: "POST" })
  .validator(
    (input: KeyedInput & { readonly grantId: string; readonly permission: GrantPermission }) => {
      const permission = oneOf(GRANT_PERMISSIONS, fields(input).permission);
      if (permission === undefined) throw new TypeError("permission must be read or read-write.");
      return { ...keyedInput(input, ["grantId"]), permission };
    },
  )
  .handler(async ({ data }) => updateGrant({ ...data, accessToken: await requireAccessToken() }));

export const revokeGrantFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly grantId: string }) => keyedInput(input, ["grantId"]))
  .handler(async ({ data }) => revokeGrant({ ...data, accessToken: await requireAccessToken() }));

export const importMemoriesFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly body: ImportRequest }) => bodyInput(input))
  .handler(async ({ data }) =>
    importMemories({ ...data, accessToken: await requireAccessToken() }),
  );

export const exportSpaceFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly memorySpaceId: string }) =>
    scopedInput(input, ["memorySpaceId"]),
  )
  .handler(async ({ data }) => exportSpace({ ...data, accessToken: await requireAccessToken() }));

const LIFECYCLE_ACTION_NAMES = [
  "archive",
  "restore",
  "delete",
] as const satisfies readonly LifecycleAction[];

export const changeLifecycleFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: KeyedInput & {
        readonly action: LifecycleAction;
        readonly memoryId: string;
        readonly reason?: string;
      },
    ) => {
      const { action, reason } = fields(input);
      const known = oneOf(LIFECYCLE_ACTION_NAMES, action);
      if (known === undefined) throw new TypeError("action must be archive, restore, or delete.");
      if (reason !== undefined && typeof reason !== "string") {
        throw new TypeError("reason must be a string.");
      }
      return {
        ...keyedInput(input, ["memoryId"]),
        action: known,
        ...(reason === undefined ? {} : { reason }),
      };
    },
  )
  .handler(async ({ data }) =>
    changeLifecycle({ ...data, accessToken: await requireAccessToken() }),
  );

export const resolveReviewFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: KeyedInput & {
        readonly body: ReviewRequest;
        readonly memoryId: string;
        readonly reviewId: string;
      },
    ) => ({ ...keyedInput(input, ["memoryId", "reviewId"]), body: requireBody(input) }),
  )
  .handler(async ({ data }) => resolveReview({ ...data, accessToken: await requireAccessToken() }));

const SEARCH_KINDS = ["policy", "strategy"] as const satisfies readonly SearchRequest["kind"][];

export const searchMemoriesFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly request: SearchRequest }) => {
    const request = fields(fields(input).request);
    const kind = oneOf(SEARCH_KINDS, request.kind);
    if (kind === undefined) throw new TypeError("request.kind must be policy or strategy.");
    return { ...scopedInput(input), request: { body: request.body, kind } };
  })
  .handler(async ({ data }) =>
    searchMemories({ ...data, accessToken: await requireAccessToken() }),
  );

export const recordFeedbackFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: KeyedInput & {
        readonly memoryId: string;
        readonly retrievalId: string;
        readonly usefulness: Usefulness;
      },
    ) => {
      const usefulness = oneOf(USEFULNESS_RATINGS, fields(input).usefulness);
      if (usefulness === undefined) {
        throw new TypeError("usefulness must be useful, neutral, or harmful.");
      }
      return { ...keyedInput(input, ["memoryId", "retrievalId"]), usefulness };
    },
  )
  .handler(async ({ data }) =>
    recordFeedback({ ...data, accessToken: await requireAccessToken() }),
  );
