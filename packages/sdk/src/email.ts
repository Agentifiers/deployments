import type {
  CreateEmailTenantRequest,
  UpdateEmailTenantRequest,
  CreateEmailDomainRequest,
  SendEmailRequest,
  EmailTenantResponse,
  EmailTenantPageResponse,
  EmailDomainResponse,
  EmailDomainPageResponse,
  EmailSendResponse,
} from "@deployments-ai/api-contract/email";
import type { PlatformContext, PlatformRequest, PlatformResponse, PlatformSdk } from "./index.ts";

export type {
  CreateEmailTenantRequest,
  UpdateEmailTenantRequest,
  CreateEmailDomainRequest,
  SendEmailRequest,
  EmailTenantResponse,
  EmailTenantPageResponse,
  EmailDomainResponse,
  EmailDomainPageResponse,
  EmailSendResponse,
} from "@deployments-ai/api-contract/email";

export interface EmailContext extends PlatformContext {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
}
export interface EmailMutationOptions {
  readonly idempotencyKey: string;
}
export interface EmailListOptions {
  readonly cursor?: string;
  readonly limit?: number;
}
export interface EmailSdk {
  readonly tenants: {
    create(
      input: CreateEmailTenantRequest,
      options: EmailMutationOptions,
    ): Promise<PlatformResponse<EmailTenantResponse>>;
    list(options?: EmailListOptions): Promise<PlatformResponse<EmailTenantPageResponse>>;
    get(tenantId: string): Promise<PlatformResponse<EmailTenantResponse>>;
    update(
      tenantId: string,
      input: UpdateEmailTenantRequest,
      options: EmailMutationOptions,
    ): Promise<PlatformResponse<EmailTenantResponse>>;
  };
  readonly domains: {
    create(
      tenantId: string,
      input: CreateEmailDomainRequest,
      options: EmailMutationOptions,
    ): Promise<PlatformResponse<EmailDomainResponse>>;
    list(
      tenantId: string,
      options?: EmailListOptions,
    ): Promise<PlatformResponse<EmailDomainPageResponse>>;
    get(domainId: string): Promise<PlatformResponse<EmailDomainResponse>>;
    refresh(
      domainId: string,
      options: EmailMutationOptions,
    ): Promise<PlatformResponse<EmailDomainResponse>>;
    revoke(
      domainId: string,
      options: EmailMutationOptions,
    ): Promise<PlatformResponse<EmailDomainResponse>>;
  };
  send(
    tenantId: string,
    input: SendEmailRequest,
    options: EmailMutationOptions,
  ): Promise<PlatformResponse<EmailSendResponse>>;
}

export function createEmailSdk(
  transport: Pick<PlatformSdk, "request">,
  context: EmailContext,
): EmailSdk {
  const request = <T>(
    method: PlatformRequest["method"],
    path: string,
    args: {
      readonly body?: unknown;
      readonly query?: EmailListOptions | undefined;
      readonly options?: EmailMutationOptions | undefined;
    } = {},
  ) =>
    transport.request<T>({
      method,
      path: `/v1/email${path}`,
      context,
      ...(args.body === undefined ? {} : { body: args.body }),
      ...(args.query ? { query: { ...args.query } } : {}),
      ...(args.options ? { idempotencyKey: args.options.idempotencyKey } : {}),
    });
  return {
    tenants: {
      create: (input, options) => request("POST", "/tenants", { body: input, options }),
      list: (options) => request("GET", "/tenants", { query: options }),
      get: (tenantId) => request("GET", `/tenants/${encodeURIComponent(tenantId)}`),
      update: (tenantId, input, options) =>
        request("PATCH", `/tenants/${encodeURIComponent(tenantId)}`, { body: input, options }),
    },
    domains: {
      create: (tenantId, input, options) =>
        request("POST", `/tenants/${encodeURIComponent(tenantId)}/domains`, {
          body: input,
          options,
        }),
      list: (tenantId, options) =>
        request("GET", `/tenants/${encodeURIComponent(tenantId)}/domains`, { query: options }),
      get: (domainId) => request("GET", `/domains/${encodeURIComponent(domainId)}`),
      refresh: (domainId, options) =>
        request("POST", `/domains/${encodeURIComponent(domainId)}/refresh`, { options }),
      revoke: (domainId, options) =>
        request("DELETE", `/domains/${encodeURIComponent(domainId)}`, { options }),
    },
    send: (tenantId, input, options) =>
      request("POST", `/tenants/${encodeURIComponent(tenantId)}/messages`, {
        body: input,
        options,
      }),
  };
}
