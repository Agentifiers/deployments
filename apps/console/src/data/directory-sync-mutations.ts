import type { PutDirectoryRequest } from "@deployments-ai/api-contract";
import { createServerFn } from "@tanstack/react-start";
import {
  createDirectoryToken,
  putDirectory,
  revokeDirectoryToken,
} from "../server/directory-sync-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import { keyedInputAt, requireBody, type KeyedInputAt } from "./server-input.ts";

type OrganizationKeyed = KeyedInputAt<"organization">;

export const putDirectoryFn = createServerFn({ method: "POST" })
  .validator(
    (input: OrganizationKeyed & { readonly body: typeof PutDirectoryRequest.Encoded }) => ({
      ...keyedInputAt("organization", input),
      body: requireBody(input),
    }),
  )
  .handler(async ({ data }) => putDirectory({ ...data, accessToken: await requireAccessToken() }));

export const createDirectoryTokenFn = createServerFn({ method: "POST" })
  .validator((input: OrganizationKeyed) => keyedInputAt("organization", input))
  .handler(async ({ data }) =>
    createDirectoryToken({ ...data, accessToken: await requireAccessToken() }),
  );

export const revokeDirectoryTokenFn = createServerFn({ method: "POST" })
  .validator((input: OrganizationKeyed & { readonly id: string }) =>
    keyedInputAt("organization", input, ["id"]),
  )
  .handler(async ({ data }) =>
    revokeDirectoryToken({ ...data, accessToken: await requireAccessToken() }),
  );
