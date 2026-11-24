import { createServerFn } from "@tanstack/react-start";
import { applySkillPlan } from "../server/managed-skill-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import type { SkillOperation } from "../skills/skill-state.ts";
import { fields, keyedInput, requireIds, type KeyedInput } from "./server-input.ts";

const MAX_PLAN_OPERATIONS = 200;

function requireOperation(input: unknown): SkillOperation {
  const operation = fields(input);
  switch (operation.kind) {
    case "install":
      return {
        ...requireIds(operation, ["managedSkillId", "managedSkillReleaseId"]),
        ...(operation.agentDefinitionId === undefined
          ? {}
          : requireIds(operation, ["agentDefinitionId"])),
        kind: "install",
      };
    case "remove": {
      const { expectedVersion } = operation;
      if (
        typeof expectedVersion !== "number" ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0
      ) {
        throw new TypeError("expectedVersion must be a non-negative integer.");
      }
      return { ...requireIds(operation, ["installationId"]), expectedVersion, kind: "remove" };
    }
    default:
      throw new TypeError("Each operation's kind must be install or remove.");
  }
}

export const applySkillPlanFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly operations: readonly SkillOperation[] }) => {
    const { operations } = fields(input);
    if (
      !Array.isArray(operations) ||
      operations.length === 0 ||
      operations.length > MAX_PLAN_OPERATIONS
    ) {
      throw new TypeError(`operations must list 1 to ${MAX_PLAN_OPERATIONS} steps.`);
    }
    return { ...keyedInput(input), operations: operations.map(requireOperation) };
  })
  .handler(async ({ data }) =>
    applySkillPlan({ ...data, accessToken: await requireAccessToken() }),
  );
