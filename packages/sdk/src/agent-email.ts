import type {
  AgentEmailDomainRecord,
  AgentEmailDraftRecord,
  AgentEmailForwardRequest,
  AgentEmailInboxBindingRecord,
  AgentEmailInboxRecord,
  AgentEmailMessageRecord,
  AgentEmailPage,
  AgentEmailPlacementRecord,
  AgentEmailPolicyRecord,
  AgentEmailReplyRequest,
  AgentEmailSuppressionRecord,
  AgentEmailThreadRecord,
  AgentEmailUsageBucket,
  AgentEmailUsageExportRecord,
  CreateAgentEmailDomainRequest,
  CreateAgentEmailBindingRequest,
  CreateAgentEmailDraftRequest,
  CreateAgentEmailInboxRequest,
  CreateAgentEmailPlacementRequest,
  CreateAgentEmailSuppressionRequest,
  ExportAgentEmailUsageRequest,
  RejectAgentEmailDraftRequest,
  SearchAgentEmailMessagesRequest,
  SearchAgentEmailThreadsRequest,
  SendAgentEmailMessageRequest,
  UpdateAgentEmailDraftRequest,
  UpdateAgentEmailInboxRequest,
  UpdateAgentEmailPlacementRequest,
  UpdateAgentEmailPolicyRequest,
} from "@deployments-ai/agent-email";
import type { PlatformContext, PlatformRequest, PlatformResponse } from "./index.ts";
import { segment } from "./runtime-sdk-client.ts";

export interface AgentEmailContext extends PlatformContext {
  readonly environmentId: string;
  readonly organizationId: string;
  readonly projectId: string;
}

export interface AgentEmailMutationOptions {
  readonly idempotencyKey: string;
}

export interface AgentEmailListOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AgentEmailInboxListOptions extends AgentEmailListOptions {
  readonly clientId?: string;
  readonly status?: AgentEmailInboxRecord["status"];
}

export interface AgentEmailMessageListOptions extends AgentEmailListOptions {
  readonly direction?: AgentEmailMessageRecord["direction"];
  readonly status?: AgentEmailMessageRecord["status"];
}

export interface AgentEmailDraftListOptions extends AgentEmailListOptions {
  readonly status?: AgentEmailDraftRecord["status"];
}

export interface AgentEmailUsageOptions {
  readonly from?: string;
  readonly inboxId?: string;
  readonly to?: string;
}

export interface AgentEmailUsageSummary {
  readonly attachmentBytes: number;
  readonly from: string;
  readonly inboundMessages: number;
  readonly organizationId: string;
  readonly outboundMessages: number;
  readonly storedBytes: number;
  readonly to: string;
}

export interface AgentEmailUsageExport {
  readonly bucket: AgentEmailUsageBucket;
  readonly csv?: string;
  readonly format: "csv" | "json";
  readonly from: string;
  readonly rows: readonly AgentEmailUsageExportRecord[];
  readonly to: string;
}

export interface AgentEmailAccessUrl {
  readonly expiresAt: string;
  readonly rawPurgedAt?: string;
  readonly rawRetentionExpiresAt?: string;
  readonly url: string;
}

export interface AgentEmailThreadDetail {
  readonly messages: readonly AgentEmailMessageRecord[];
  readonly nextCursor?: string;
  readonly thread: AgentEmailThreadRecord;
}

export interface AgentEmailSdk {
  readonly inboxes: {
    create(
      input: CreateAgentEmailInboxRequest,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailInboxRecord>>;
    list(
      options?: AgentEmailInboxListOptions,
    ): Promise<PlatformResponse<AgentEmailPage<AgentEmailInboxRecord>>>;
    get(inboxId: string): Promise<PlatformResponse<AgentEmailInboxRecord>>;
    update(
      inboxId: string,
      input: UpdateAgentEmailInboxRequest,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailInboxRecord>>;
  };
  readonly bindings: {
    create(
      inboxId: string,
      input: CreateAgentEmailBindingRequest,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailInboxBindingRecord>>;
    list(
      inboxId: string,
      options?: AgentEmailListOptions,
    ): Promise<PlatformResponse<AgentEmailPage<AgentEmailInboxBindingRecord>>>;
    get(bindingId: string): Promise<PlatformResponse<AgentEmailInboxBindingRecord>>;
    delete(
      bindingId: string,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailInboxBindingRecord>>;
  };
  readonly messages: {
    send(
      inboxId: string,
      input: SendAgentEmailMessageRequest,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailMessageRecord>>;
    list(
      inboxId: string,
      options?: AgentEmailMessageListOptions,
    ): Promise<PlatformResponse<AgentEmailPage<AgentEmailMessageRecord>>>;
    search(
      inboxId: string,
      input: SearchAgentEmailMessagesRequest,
    ): Promise<PlatformResponse<AgentEmailPage<AgentEmailMessageRecord>>>;
    get(messageId: string): Promise<PlatformResponse<AgentEmailMessageRecord>>;
    reply(
      messageId: string,
      input: AgentEmailReplyRequest,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailMessageRecord>>;
    replyAll(
      messageId: string,
      input: AgentEmailReplyRequest,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailMessageRecord>>;
    forward(
      messageId: string,
      input: AgentEmailForwardRequest,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailMessageRecord>>;
    rawAccess(messageId: string): Promise<PlatformResponse<AgentEmailAccessUrl>>;
    reprocess(
      messageId: string,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailMessageRecord>>;
  };
  readonly attachments: {
    accessUrl(attachmentId: string): Promise<PlatformResponse<AgentEmailAccessUrl>>;
  };
  readonly threads: {
    list(
      inboxId: string,
      options?: AgentEmailListOptions,
    ): Promise<PlatformResponse<AgentEmailPage<AgentEmailThreadRecord>>>;
    search(
      inboxId: string,
      input: SearchAgentEmailThreadsRequest,
    ): Promise<PlatformResponse<AgentEmailPage<AgentEmailThreadRecord>>>;
    get(
      inboxId: string,
      threadId: string,
      options?: AgentEmailListOptions,
    ): Promise<PlatformResponse<AgentEmailThreadDetail>>;
  };
  readonly domains: {
    create(
      input: CreateAgentEmailDomainRequest,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailDomainRecord>>;
    list(
      options?: AgentEmailListOptions,
    ): Promise<PlatformResponse<AgentEmailPage<AgentEmailDomainRecord>>>;
    get(domainId: string): Promise<PlatformResponse<AgentEmailDomainRecord>>;
    refresh(
      domainId: string,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailDomainRecord>>;
    revoke(
      domainId: string,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailDomainRecord>>;
  };
  readonly placements: {
    create(
      input: CreateAgentEmailPlacementRequest,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailPlacementRecord>>;
    list(
      options?: AgentEmailListOptions,
    ): Promise<PlatformResponse<AgentEmailPage<AgentEmailPlacementRecord>>>;
    get(placementId: string): Promise<PlatformResponse<AgentEmailPlacementRecord>>;
    update(
      placementId: string,
      input: UpdateAgentEmailPlacementRequest,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailPlacementRecord>>;
  };
  readonly drafts: {
    create(
      inboxId: string,
      input: CreateAgentEmailDraftRequest,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailDraftRecord>>;
    list(
      inboxId: string,
      options?: AgentEmailDraftListOptions,
    ): Promise<PlatformResponse<AgentEmailPage<AgentEmailDraftRecord>>>;
    get(draftId: string): Promise<PlatformResponse<AgentEmailDraftRecord>>;
    update(
      draftId: string,
      input: UpdateAgentEmailDraftRequest,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailDraftRecord>>;
    submit(
      draftId: string,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailDraftRecord>>;
    approve(
      draftId: string,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailDraftRecord>>;
    reject(
      draftId: string,
      input: RejectAgentEmailDraftRequest,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailDraftRecord>>;
    cancel(
      draftId: string,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailDraftRecord>>;
    send(
      draftId: string,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailMessageRecord>>;
  };
  readonly usage: {
    get(options?: AgentEmailUsageOptions): Promise<PlatformResponse<AgentEmailUsageSummary>>;
    export(input: ExportAgentEmailUsageRequest): Promise<PlatformResponse<AgentEmailUsageExport>>;
  };
  readonly policy: {
    get(): Promise<PlatformResponse<AgentEmailPolicyRecord>>;
    update(
      input: UpdateAgentEmailPolicyRequest,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailPolicyRecord>>;
  };
  readonly suppressions: {
    create(
      input: CreateAgentEmailSuppressionRequest,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailSuppressionRecord>>;
    list(
      options?: AgentEmailListOptions,
    ): Promise<PlatformResponse<AgentEmailPage<AgentEmailSuppressionRecord>>>;
    remove(
      suppressionId: string,
      options: AgentEmailMutationOptions,
    ): Promise<PlatformResponse<AgentEmailSuppressionRecord>>;
  };
}

interface AgentEmailTransport {
  request<T = unknown>(request: PlatformRequest): Promise<PlatformResponse<T>>;
}

const basePath = "/v1/agent-email";

function query(options: object | undefined) {
  if (!options) return undefined;
  return Object.fromEntries(
    Object.entries(options).filter((entry): entry is [string, boolean | number | string] =>
      ["boolean", "number", "string"].includes(typeof entry[1]),
    ),
  );
}

export function createAgentEmailSdk(
  transport: AgentEmailTransport,
  context: AgentEmailContext,
): AgentEmailSdk {
  const request = <T>(
    method: PlatformRequest["method"],
    path: string,
    args: {
      readonly body?: unknown;
      readonly query?: object | undefined;
      readonly options?: AgentEmailMutationOptions | undefined;
    } = {},
  ) => {
    const requestQuery = query(args.query);
    return transport.request<T>({
      method,
      path: `${basePath}${path}`,
      context,
      ...(args.body === undefined ? {} : { body: args.body }),
      ...(requestQuery ? { query: requestQuery } : {}),
      ...(args.options?.idempotencyKey ? { idempotencyKey: args.options.idempotencyKey } : {}),
    });
  };

  const lifecycle = <T>(path: string, options: AgentEmailMutationOptions) =>
    request<T>("POST", path, { options });

  return {
    inboxes: {
      create: (input, options) => request("POST", "/inboxes", { body: input, options }),
      list: (options) => request("GET", "/inboxes", { query: options }),
      get: (inboxId) => request("GET", `/inboxes/${segment(inboxId)}`),
      update: (inboxId, input, options) =>
        request("PATCH", `/inboxes/${segment(inboxId)}`, { body: input, options }),
    },
    bindings: {
      create: (inboxId, input, options) =>
        request("POST", `/inboxes/${segment(inboxId)}/bindings`, { body: input, options }),
      list: (inboxId, options) =>
        request("GET", `/inboxes/${segment(inboxId)}/bindings`, { query: options }),
      get: (bindingId) => request("GET", `/bindings/${segment(bindingId)}`),
      delete: (bindingId, options) =>
        request("DELETE", `/bindings/${segment(bindingId)}`, { options }),
    },
    messages: {
      send: (inboxId, input, options) =>
        request("POST", `/inboxes/${segment(inboxId)}/messages`, { body: input, options }),
      list: (inboxId, options) =>
        request("GET", `/inboxes/${segment(inboxId)}/messages`, { query: options }),
      search: (inboxId, input) =>
        request("POST", `/inboxes/${segment(inboxId)}/messages/search`, { body: input }),
      get: (messageId) => request("GET", `/messages/${segment(messageId)}`),
      reply: (messageId, input, options) =>
        request("POST", `/messages/${segment(messageId)}/reply`, { body: input, options }),
      replyAll: (messageId, input, options) =>
        request("POST", `/messages/${segment(messageId)}/reply-all`, { body: input, options }),
      forward: (messageId, input, options) =>
        request("POST", `/messages/${segment(messageId)}/forward`, { body: input, options }),
      rawAccess: (messageId) => request("POST", `/messages/${segment(messageId)}/raw/access`),
      reprocess: (messageId, options) =>
        lifecycle(`/messages/${segment(messageId)}/raw/reprocess`, options),
    },
    attachments: {
      accessUrl: (attachmentId) =>
        request("POST", `/attachments/${segment(attachmentId)}/access-url`),
    },
    threads: {
      list: (inboxId, options) =>
        request("GET", `/inboxes/${segment(inboxId)}/threads`, { query: options }),
      search: (inboxId, input) =>
        request("POST", `/inboxes/${segment(inboxId)}/threads/search`, { body: input }),
      get: (inboxId, threadId, options) =>
        request("GET", `/inboxes/${segment(inboxId)}/threads/${segment(threadId)}`, {
          query: options,
        }),
    },
    domains: {
      create: (input, options) => request("POST", "/domains", { body: input, options }),
      list: (options) => request("GET", "/domains", { query: options }),
      get: (domainId) => request("GET", `/domains/${segment(domainId)}`),
      refresh: (domainId, options) => lifecycle(`/domains/${segment(domainId)}/refresh`, options),
      revoke: (domainId, options) => lifecycle(`/domains/${segment(domainId)}/revoke`, options),
    },
    placements: {
      create: (input, options) => request("POST", "/placements", { body: input, options }),
      list: (options) => request("GET", "/placements", { query: options }),
      get: (placementId) => request("GET", `/placements/${segment(placementId)}`),
      update: (placementId, input, options) =>
        request("PATCH", `/placements/${segment(placementId)}`, { body: input, options }),
    },
    drafts: {
      create: (inboxId, input, options) =>
        request("POST", `/inboxes/${segment(inboxId)}/drafts`, { body: input, options }),
      list: (inboxId, options) =>
        request("GET", `/inboxes/${segment(inboxId)}/drafts`, { query: options }),
      get: (draftId) => request("GET", `/drafts/${segment(draftId)}`),
      update: (draftId, input, options) =>
        request("PATCH", `/drafts/${segment(draftId)}`, { body: input, options }),
      submit: (draftId, options) => lifecycle(`/drafts/${segment(draftId)}/submit`, options),
      approve: (draftId, options) => lifecycle(`/drafts/${segment(draftId)}/approve`, options),
      reject: (draftId, input, options) =>
        request("POST", `/drafts/${segment(draftId)}/reject`, { body: input, options }),
      cancel: (draftId, options) => lifecycle(`/drafts/${segment(draftId)}/cancel`, options),
      send: (draftId, options) => lifecycle(`/drafts/${segment(draftId)}/send`, options),
    },
    usage: {
      get: (options) => request("GET", "/usage", { query: options }),
      export: (input) => request("POST", "/usage/export", { body: input }),
    },
    policy: {
      get: () => request("GET", "/policy"),
      update: (input, options) => request("PATCH", "/policy", { body: input, options }),
    },
    suppressions: {
      create: (input, options) => request("POST", "/suppressions", { body: input, options }),
      list: (options) => request("GET", "/suppressions", { query: options }),
      remove: (suppressionId, options) =>
        lifecycle(`/suppressions/${segment(suppressionId)}/remove`, options),
    },
  };
}
