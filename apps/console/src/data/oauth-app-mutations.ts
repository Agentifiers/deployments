import type {
  BeginProviderAuthorizationRequest,
  CreateProviderApplicationRequest,
  RevokeAdministrationResourceRequest,
  RotateProviderApplicationSecretRequest,
} from "@deployments-ai/api-contract/providers";
import { createServerFn } from "@tanstack/react-start";
import type { ReturnTarget } from "../connections/oauth.ts";
import {
  archiveApp,
  beginAuthorization,
  createApp,
  rotateAppSecret,
} from "../server/oauth-app-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  fields,
  keyedInput,
  optionalIdLists,
  requireBody,
  requireIds,
  type KeyedInput,
} from "./server-input.ts";

interface BodyInput<Body> extends KeyedInput {
  readonly body: Body;
}

type AppInput<Body> = BodyInput<Body> & { readonly appId: string };

function bodyInput<const Field extends string = never>(input: unknown, ids: readonly Field[] = []) {
  return { ...keyedInput(input, ids), body: requireBody(input) };
}

function returnTarget(input: unknown): ReturnTarget {
  const target = fields(fields(input).target);
  if (target.kind === "connect") return { kind: "connect" };
  const { since } = target;
  if (
    target.kind !== "rebind" ||
    typeof since !== "string" ||
    !Number.isFinite(Date.parse(since))
  ) {
    throw new TypeError("target must be a connect or a rebind with an ISO since.");
  }
  return {
    kind: "rebind",
    oldConnectionId: requireIds(target, ["oldConnectionId"]).oldConnectionId,
    since: new Date(since).toISOString(),
    ...optionalIdLists(target, ["include", "skip", "skipDeployments"]),
  };
}

export const createOAuthAppFn = createServerFn({ method: "POST" })
  .validator((input: BodyInput<typeof CreateProviderApplicationRequest.Encoded>) =>
    bodyInput(input),
  )
  .handler(async ({ data }) => createApp({ ...data, accessToken: await requireAccessToken() }));

export const rotateOAuthAppSecretFn = createServerFn({ method: "POST" })
  .validator((input: AppInput<typeof RotateProviderApplicationSecretRequest.Encoded>) =>
    bodyInput(input, ["appId"]),
  )
  .handler(async ({ data }) =>
    rotateAppSecret({ ...data, accessToken: await requireAccessToken() }),
  );

export const archiveOAuthAppFn = createServerFn({ method: "POST" })
  .validator((input: AppInput<typeof RevokeAdministrationResourceRequest.Encoded>) =>
    bodyInput(input, ["appId"]),
  )
  .handler(async ({ data }) => archiveApp({ ...data, accessToken: await requireAccessToken() }));

/** The server adds `returnTo`, so the browser cannot choose where the callback sends it. */
export const beginAuthorizationFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: BodyInput<Omit<typeof BeginProviderAuthorizationRequest.Encoded, "returnTo">> & {
        readonly target: ReturnTarget;
      },
    ) => ({ ...bodyInput(input), target: returnTarget(input) }),
  )
  .handler(async ({ data }) =>
    beginAuthorization({ ...data, accessToken: await requireAccessToken() }),
  );
