import type {
  CreateMcpServerRequest,
  UpdateMcpServerRequest,
} from "@deployments-ai/api-contract/tooling";
import { createServerFn } from "@tanstack/react-start";
import {
  archiveMcpServer,
  createMcpConnection,
  createMcpServer,
  discoverMcpServer,
  revokeMcpConnection,
  updateMcpServer,
} from "../server/mcp-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import { fields, keyedInput, requireBody, type KeyedInput } from "./server-input.ts";

interface ServerInput extends KeyedInput {
  readonly serverId: string;
}

export const createMcpServerFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly body: typeof CreateMcpServerRequest.Encoded }) => ({
    ...keyedInput(input),
    body: requireBody(input),
  }))
  .handler(async ({ data }) =>
    createMcpServer({ ...data, accessToken: await requireAccessToken() }),
  );

export const updateMcpServerFn = createServerFn({ method: "POST" })
  .validator((input: ServerInput & { readonly body: typeof UpdateMcpServerRequest.Encoded }) => ({
    ...keyedInput(input, ["serverId"]),
    body: requireBody(input),
  }))
  .handler(async ({ data }) =>
    updateMcpServer({ ...data, accessToken: await requireAccessToken() }),
  );

export const discoverMcpServerFn = createServerFn({ method: "POST" })
  .validator((input: ServerInput) => keyedInput(input, ["serverId"]))
  .handler(async ({ data }) =>
    discoverMcpServer({ ...data, accessToken: await requireAccessToken() }),
  );

export const archiveMcpServerFn = createServerFn({ method: "POST" })
  .validator((input: ServerInput & { readonly expectedVersion: number }) => {
    const { expectedVersion } = fields(input);
    if (
      typeof expectedVersion !== "number" ||
      !Number.isSafeInteger(expectedVersion) ||
      expectedVersion < 0
    ) {
      throw new TypeError("expectedVersion must be a non-negative integer.");
    }
    return { ...keyedInput(input, ["serverId"]), expectedVersion };
  })
  .handler(async ({ data }) =>
    archiveMcpServer({ ...data, accessToken: await requireAccessToken() }),
  );

export const createMcpConnectionFn = createServerFn({ method: "POST" })
  .validator((input: ServerInput) => keyedInput(input, ["serverId"]))
  .handler(async ({ data }) =>
    createMcpConnection({ ...data, accessToken: await requireAccessToken() }),
  );

export const revokeMcpConnectionFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly connectionId: string }) =>
    keyedInput(input, ["connectionId"]),
  )
  .handler(async ({ data }) =>
    revokeMcpConnection({ ...data, accessToken: await requireAccessToken() }),
  );
