import { createServerFn } from "@tanstack/react-start";
import type { CreateBudgetBody, UpdateBudgetBody } from "../budgets/budget-state.ts";
import { oneOf } from "../observability/range.ts";
import {
  archiveBudget,
  createBudget,
  setBudgetStatus,
  updateBudget,
} from "../server/budget-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import { fields, keyedInputAt, requireBody, type KeyedInputAt } from "./server-input.ts";

interface KeyedBudgetInput extends KeyedInputAt<"organization"> {
  readonly budgetId: string;
}

const STATUS_CHANGES = ["pause", "resume"] as const;

export const createBudgetFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInputAt<"organization"> & { readonly body: CreateBudgetBody }) => ({
    ...keyedInputAt("organization", input),
    body: requireBody(input),
  }))
  .handler(async ({ data }) =>
    createBudget({
      ...data,
      accessToken: await requireAccessToken(),
      organizationId: data.scope.organizationId,
    }),
  );

export const updateBudgetFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: KeyedBudgetInput & {
        readonly body: UpdateBudgetBody;
        readonly expectedVersion: number;
      },
    ) => {
      const { expectedVersion } = fields(input);
      if (
        typeof expectedVersion !== "number" ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 1
      ) {
        throw new TypeError("expectedVersion must be a positive integer.");
      }
      return {
        ...keyedInputAt("organization", input, ["budgetId"]),
        body: requireBody(input),
        expectedVersion,
      };
    },
  )
  .handler(async ({ data }) =>
    updateBudget({
      ...data,
      accessToken: await requireAccessToken(),
      organizationId: data.scope.organizationId,
    }),
  );

export const setBudgetStatusFn = createServerFn({ method: "POST" })
  .validator((input: KeyedBudgetInput & { readonly change: (typeof STATUS_CHANGES)[number] }) => {
    const change = oneOf(STATUS_CHANGES, fields(input).change);
    if (!change) throw new TypeError("change must be pause or resume.");
    return { ...keyedInputAt("organization", input, ["budgetId"]), change };
  })
  .handler(async ({ data }) =>
    setBudgetStatus({
      ...data,
      accessToken: await requireAccessToken(),
      organizationId: data.scope.organizationId,
    }),
  );

export const archiveBudgetFn = createServerFn({ method: "POST" })
  .validator((input: KeyedBudgetInput) => keyedInputAt("organization", input, ["budgetId"]))
  .handler(async ({ data }) =>
    archiveBudget({
      ...data,
      accessToken: await requireAccessToken(),
      organizationId: data.scope.organizationId,
    }),
  );
