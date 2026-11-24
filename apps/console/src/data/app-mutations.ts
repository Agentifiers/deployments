import type {
  AttachAppDomainRequest,
  PutAppGrantRequest,
  SetAppPublicationRequest,
  UpdateAppRequest,
} from "@deployments-ai/api-contract";
import { createServerFn } from "@tanstack/react-start";
import {
  archiveApp,
  attachAppDomain,
  detachAppDomain,
  eraseApp,
  promoteAppRelease,
  putAppGrant,
  refreshAppDomain,
  removeAppGrant,
  setAppPublication,
  updateApp,
} from "../server/app-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import {
  keyedInput,
  requireBody,
  scopedInput,
  type KeyedInput,
  type ScopedInput,
} from "./server-input.ts";

interface AppInput extends KeyedInput {
  readonly appId: string;
}

export const updateAppFn = createServerFn({ method: "POST" })
  .validator((input: AppInput & { readonly body: typeof UpdateAppRequest.Encoded }) => ({
    ...keyedInput(input, ["appId"]),
    body: requireBody(input),
  }))
  .handler(async ({ data }) => updateApp({ ...data, accessToken: await requireAccessToken() }));

export const archiveAppFn = createServerFn({ method: "POST" })
  .validator((input: AppInput) => keyedInput(input, ["appId"]))
  .handler(async ({ data }) => archiveApp({ ...data, accessToken: await requireAccessToken() }));

export const eraseAppFn = createServerFn({ method: "POST" })
  .validator((input: AppInput) => keyedInput(input, ["appId"]))
  .handler(async ({ data }) => eraseApp({ ...data, accessToken: await requireAccessToken() }));

export const putAppGrantFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: AppInput & {
        readonly body: typeof PutAppGrantRequest.Encoded;
        readonly principalId: string;
      },
    ) => ({ ...keyedInput(input, ["appId", "principalId"]), body: requireBody(input) }),
  )
  .handler(async ({ data }) => putAppGrant({ ...data, accessToken: await requireAccessToken() }));

export const removeAppGrantFn = createServerFn({ method: "POST" })
  .validator((input: AppInput & { readonly principalId: string }) =>
    keyedInput(input, ["appId", "principalId"]),
  )
  .handler(async ({ data }) =>
    removeAppGrant({ ...data, accessToken: await requireAccessToken() }),
  );

export const promoteAppReleaseFn = createServerFn({ method: "POST" })
  .validator((input: AppInput & { readonly releaseId: string }) =>
    keyedInput(input, ["appId", "releaseId"]),
  )
  .handler(async ({ data }) =>
    promoteAppRelease({ ...data, accessToken: await requireAccessToken() }),
  );

export const setAppPublicationFn = createServerFn({ method: "POST" })
  .validator((input: AppInput & { readonly body: typeof SetAppPublicationRequest.Encoded }) => ({
    ...keyedInput(input, ["appId"]),
    body: requireBody(input),
  }))
  .handler(async ({ data }) =>
    setAppPublication({ ...data, accessToken: await requireAccessToken() }),
  );

export const attachAppDomainFn = createServerFn({ method: "POST" })
  .validator((input: AppInput & { readonly body: typeof AttachAppDomainRequest.Encoded }) => ({
    ...keyedInput(input, ["appId"]),
    body: requireBody(input),
  }))
  .handler(async ({ data }) =>
    attachAppDomain({ ...data, accessToken: await requireAccessToken() }),
  );

export const refreshAppDomainFn = createServerFn({ method: "POST" })
  .validator((input: ScopedInput & { readonly appId: string; readonly domainId: string }) =>
    scopedInput(input, ["appId", "domainId"]),
  )
  .handler(async ({ data }) =>
    refreshAppDomain({ ...data, accessToken: await requireAccessToken() }),
  );

export const detachAppDomainFn = createServerFn({ method: "POST" })
  .validator((input: AppInput & { readonly domainId: string }) =>
    keyedInput(input, ["appId", "domainId"]),
  )
  .handler(async ({ data }) =>
    detachAppDomain({ ...data, accessToken: await requireAccessToken() }),
  );
