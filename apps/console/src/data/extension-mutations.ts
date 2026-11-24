import { createServerFn } from "@tanstack/react-start";
import type { CreateWrite, UpdateWrite } from "../extensions/extension-draft.ts";
import {
  archiveExtension,
  createExtension,
  syncConnectionTools,
  updateExtension,
} from "../server/extension-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import { fields, keyedInput, requireBody, type KeyedInput } from "./server-input.ts";

interface ToolInput extends KeyedInput {
  readonly toolName: string;
}

function toolInput(input: unknown) {
  const { toolName } = fields(input);
  if (typeof toolName !== "string" || toolName.length === 0 || toolName.length > 256) {
    throw new TypeError("toolName must be a tool name.");
  }
  return { ...keyedInput(input), toolName };
}

function writeInput(input: unknown) {
  const { artifact } = fields(input);
  if (artifact !== undefined && (typeof artifact !== "object" || artifact === null)) {
    throw new TypeError("artifact must be an object.");
  }
  return { body: requireBody(input), ...(artifact === undefined ? {} : { artifact }) };
}

export const createExtensionFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & CreateWrite) => ({ ...keyedInput(input), ...writeInput(input) }))
  .handler(async ({ data }) =>
    createExtension({ ...data, accessToken: await requireAccessToken() }),
  );

export const updateExtensionFn = createServerFn({ method: "POST" })
  .validator((input: ToolInput & UpdateWrite) => ({ ...toolInput(input), ...writeInput(input) }))
  .handler(async ({ data }) =>
    updateExtension({ ...data, accessToken: await requireAccessToken() }),
  );

export const archiveExtensionFn = createServerFn({ method: "POST" })
  .validator((input: ToolInput & { readonly expectedVersion: number }) => {
    const { expectedVersion } = fields(input);
    if (
      typeof expectedVersion !== "number" ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0
    ) {
      throw new TypeError("expectedVersion must be a non-negative integer.");
    }
    return { ...toolInput(input), expectedVersion };
  })
  .handler(async ({ data }) =>
    archiveExtension({ ...data, accessToken: await requireAccessToken() }),
  );

export const syncConnectionToolsFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly connectionId: string }) =>
    keyedInput(input, ["connectionId"]),
  )
  .handler(async ({ data }) =>
    syncConnectionTools({ ...data, accessToken: await requireAccessToken() }),
  );
