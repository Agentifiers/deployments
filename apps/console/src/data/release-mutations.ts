import { createServerFn } from "@tanstack/react-start";
import {
  archiveAgentRelease,
  promoteAgentRelease,
  publishAgentRelease,
} from "../server/release-data.ts";
import { requireAccessToken } from "../server/session.ts";
import { keyedInput, requireBody, type KeyedInput } from "./server-input.ts";

interface MutationInput extends KeyedInput {
  readonly body: unknown;
}

/** `publishAgentRelease`: the body is `{ expectedDefinitionVersion }`. */
export const publishAgentReleaseFn = createServerFn({ method: "POST" })
  .validator((input: MutationInput & { readonly definitionId: string }) => ({
    ...keyedInput(input, ["definitionId"]),
    body: requireBody(input),
  }))
  .handler(async ({ data }) => publishAgentRelease(await requireAccessToken(), data));

/** `promoteAgentRelease`: the body is `{ targetEnvironmentId }`. */
export const promoteAgentReleaseFn = createServerFn({ method: "POST" })
  .validator((input: MutationInput & { readonly releaseId: string }) => ({
    ...keyedInput(input, ["releaseId"]),
    body: requireBody(input),
  }))
  .handler(async ({ data }) => promoteAgentRelease(await requireAccessToken(), data));

/** `archiveAgentRelease`: the body is `{ expectedVersion }`. */
export const archiveAgentReleaseFn = createServerFn({ method: "POST" })
  .validator((input: MutationInput & { readonly releaseId: string }) => ({
    ...keyedInput(input, ["releaseId"]),
    body: requireBody(input),
  }))
  .handler(async ({ data }) => archiveAgentRelease(await requireAccessToken(), data));
