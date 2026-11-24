import type {
  AddLoginDomainRequest,
  PutIdentityProviderRequest,
  SetIdentityProviderStateRequest,
} from "@deployments-ai/api-contract";
import { createServerFn } from "@tanstack/react-start";
import { requireAccessToken } from "../server/session.ts";
import {
  addLoginDomain,
  deleteIdentityProvider,
  deleteIdentityProviderLink,
  putIdentityProvider,
  removeLoginDomain,
  setIdentityProviderState,
  verifyLoginDomain,
} from "../server/sign-in-actions.ts";
import { keyedInputAt, requireBody, type KeyedInputAt } from "./server-input.ts";

type OrganizationKeyed = KeyedInputAt<"organization">;

export const addLoginDomainFn = createServerFn({ method: "POST" })
  .validator(
    (input: OrganizationKeyed & { readonly body: typeof AddLoginDomainRequest.Encoded }) => ({
      ...keyedInputAt("organization", input),
      body: requireBody(input),
    }),
  )
  .handler(async ({ data }) =>
    addLoginDomain({ ...data, accessToken: await requireAccessToken() }),
  );

export const verifyLoginDomainFn = createServerFn({ method: "POST" })
  .validator((input: OrganizationKeyed & { readonly id: string }) =>
    keyedInputAt("organization", input, ["id"]),
  )
  .handler(async ({ data }) =>
    verifyLoginDomain({ ...data, accessToken: await requireAccessToken() }),
  );

export const removeLoginDomainFn = createServerFn({ method: "POST" })
  .validator((input: OrganizationKeyed & { readonly id: string }) =>
    keyedInputAt("organization", input, ["id"]),
  )
  .handler(async ({ data }) =>
    removeLoginDomain({ ...data, accessToken: await requireAccessToken() }),
  );

export const putIdentityProviderFn = createServerFn({ method: "POST" })
  .validator(
    (input: OrganizationKeyed & { readonly body: typeof PutIdentityProviderRequest.Encoded }) => ({
      ...keyedInputAt("organization", input),
      body: requireBody(input),
    }),
  )
  .handler(async ({ data }) =>
    putIdentityProvider({ ...data, accessToken: await requireAccessToken() }),
  );

export const setIdentityProviderStateFn = createServerFn({ method: "POST" })
  .validator(
    (
      input: OrganizationKeyed & {
        readonly body: typeof SetIdentityProviderStateRequest.Encoded;
      },
    ) => ({ ...keyedInputAt("organization", input), body: requireBody(input) }),
  )
  .handler(async ({ data }) =>
    setIdentityProviderState({ ...data, accessToken: await requireAccessToken() }),
  );

export const deleteIdentityProviderFn = createServerFn({ method: "POST" })
  .validator((input: OrganizationKeyed) => keyedInputAt("organization", input))
  .handler(async ({ data }) =>
    deleteIdentityProvider({ ...data, accessToken: await requireAccessToken() }),
  );

export const deleteIdentityProviderLinkFn = createServerFn({ method: "POST" })
  .validator((input: OrganizationKeyed & { readonly id: string }) =>
    keyedInputAt("organization", input, ["id"]),
  )
  .handler(async ({ data }) =>
    deleteIdentityProviderLink({ ...data, accessToken: await requireAccessToken() }),
  );
