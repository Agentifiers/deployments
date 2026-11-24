import { createServerFn } from "@tanstack/react-start";
import type { ToolBindingChanges } from "../agents/runtime-config.ts";
import { parseBindingChanges } from "../agents/tool-bindings.ts";
import { deployRelease, saveToolBindings } from "../server/tool-binding-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import { fields, keyedInput, requireIds, type KeyedInput } from "./server-input.ts";

interface BindingInput extends KeyedInput {
  readonly changes: ToolBindingChanges;
  readonly definitionId: string;
}

function version(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer.`);
  }
  return value;
}

function isDesiredState(value: unknown): value is "paused" | "running" {
  return value === "paused" || value === "running";
}

export const saveToolBindingsFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: BindingInput & {
        readonly deploymentId: string;
        readonly expectedVersion: number;
      },
    ) => {
      const value = fields(input);
      return {
        ...keyedInput(input, ["definitionId", "deploymentId"]),
        changes: parseBindingChanges(value.changes),
        expectedVersion: version(value.expectedVersion, "expectedVersion"),
      };
    },
  )
  .handler(async ({ data }) =>
    saveToolBindings({ ...data, accessToken: await requireAccessToken() }),
  );

export const deployReleaseFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: BindingInput & {
        readonly desiredState: "paused" | "running";
        readonly releaseId: string;
        readonly seed?: {
          readonly deploymentId: string;
          readonly version: number;
        };
      },
    ) => {
      const value = fields(input);
      const { desiredState } = value;
      if (!isDesiredState(desiredState)) {
        throw new TypeError("desiredState must be paused or running.");
      }
      const seed =
        value.seed === undefined
          ? undefined
          : {
              ...requireIds(value.seed, ["deploymentId"]),
              version: version(fields(value.seed).version, "seed.version"),
            };
      return {
        ...keyedInput(input, ["definitionId", "releaseId"]),
        changes: parseBindingChanges(value.changes),
        desiredState,
        seed,
      };
    },
  )
  .handler(async ({ data }) => deployRelease({ ...data, accessToken: await requireAccessToken() }));
