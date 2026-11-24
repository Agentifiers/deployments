import type {
  CreateEmailDomainRequest,
  CreateEmailTenantRequest,
  SendEmailRequest,
  UpdateEmailTenantRequest,
} from "@deployments-ai/api-contract/email";
import { createServerFn } from "@tanstack/react-start";
import {
  createTenant,
  createTenantDomain,
  refreshTenantDomain,
  revokeTenantDomain,
  sendTenantEmail,
  updateTenant,
} from "../server/email-tenant-actions.ts";
import { requireAccessToken } from "../server/session.ts";
import { keyedInput, requireBody, type KeyedInput } from "./server-input.ts";

interface TenantInput extends KeyedInput {
  readonly tenantId: string;
}

function tenantBodyInput(input: unknown) {
  return { ...keyedInput(input, ["tenantId"]), body: requireBody(input) };
}

export const createTenantFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly body: typeof CreateEmailTenantRequest.Encoded }) => ({
    ...keyedInput(input),
    body: requireBody(input),
  }))
  .handler(async ({ data }) => createTenant({ ...data, accessToken: await requireAccessToken() }));

export const updateTenantFn = createServerFn({ method: "POST" })
  .validator((input: TenantInput & { readonly body: typeof UpdateEmailTenantRequest.Encoded }) =>
    tenantBodyInput(input),
  )
  .handler(async ({ data }) => updateTenant({ ...data, accessToken: await requireAccessToken() }));

export const createTenantDomainFn = createServerFn({ method: "POST" })
  .validator((input: TenantInput & { readonly body: typeof CreateEmailDomainRequest.Encoded }) =>
    tenantBodyInput(input),
  )
  .handler(async ({ data }) =>
    createTenantDomain({ ...data, accessToken: await requireAccessToken() }),
  );

export const refreshTenantDomainFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly domainId: string }) => keyedInput(input, ["domainId"]))
  .handler(async ({ data }) =>
    refreshTenantDomain({ ...data, accessToken: await requireAccessToken() }),
  );

export const revokeTenantDomainFn = createServerFn({ method: "POST" })
  .validator((input: KeyedInput & { readonly domainId: string }) => keyedInput(input, ["domainId"]))
  .handler(async ({ data }) =>
    revokeTenantDomain({ ...data, accessToken: await requireAccessToken() }),
  );

export const sendTenantEmailFn = createServerFn({ method: "POST" })
  .validator((input: TenantInput & { readonly body: typeof SendEmailRequest.Encoded }) =>
    tenantBodyInput(input),
  )
  .handler(async ({ data }) =>
    sendTenantEmail({ ...data, accessToken: await requireAccessToken() }),
  );
