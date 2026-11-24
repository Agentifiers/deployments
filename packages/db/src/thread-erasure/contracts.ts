import type {
  GovernanceOperation,
  RetentionCleanup,
  TenantRecord,
  TenantRecordPage,
} from "../governance/contracts.ts";
import type { Ulid } from "../ids.ts";
import type { PlatformRecord } from "../records/index.ts";
import type { EndUserKey } from "../records/conversation-erasure.ts";
import type { FencedInboxMessage } from "./mail-sweep.ts";

export type ConversationErasureItem = Extract<
  PlatformRecord,
  { readonly itemType: "conversation-erasure-item" }
>;
export type ConversationErasureMailItem = Extract<
  PlatformRecord,
  { readonly itemType: "conversation-erasure-mail-item" }
>;
export type ThreadTombstone = Extract<PlatformRecord, { readonly itemType: "thread-tombstone" }>;
export type ErasedThreadRun = Extract<PlatformRecord, { readonly itemType: "run" }>;

export interface ConversationErasureScope {
  readonly environmentId: Ulid;
  readonly organizationId: Ulid;
  readonly projectId: Ulid;
}

export interface ConversationErasureRequester {
  readonly id: Ulid;
  readonly type: "principal" | "service-account";
}

export type RequestThreadErasureResult =
  | { readonly kind: "created" | "replayed"; readonly operation: GovernanceOperation }
  | { readonly kind: "not-erasable" | "not-found" | "thread-active" };

export type RequestEndUserErasureResult = {
  readonly kind: "created" | "replayed";
  readonly operation: GovernanceOperation;
};

export type FenceItemResult =
  | { readonly kind: "fenced"; readonly item: ConversationErasureItem }
  | { readonly kind: "runs-active"; readonly runs: readonly ErasedThreadRun[] };

export interface ConversationErasureRequests {
  readonly requestThreadErasure: (input: {
    readonly requester: ConversationErasureRequester;
    readonly scope: ConversationErasureScope;
    readonly threadId: Ulid;
  }) => Promise<RequestThreadErasureResult>;
  readonly requestEndUserErasure: (input: {
    readonly endUserKey: EndUserKey;
    readonly environmentId: Ulid;
    readonly organizationId: Ulid;
    readonly requester: ConversationErasureRequester;
  }) => Promise<RequestEndUserErasureResult>;
  readonly getOperation: (
    organizationId: string,
    operationId: string,
  ) => Promise<GovernanceOperation | undefined>;
  readonly isOrganizationInboxAddress: (
    organizationId: string,
    address: string,
  ) => Promise<boolean>;
}

export interface ConversationErasureStore extends ConversationErasureRequests {
  readonly getThreadTombstone: (
    organizationId: string,
    threadId: string,
  ) => Promise<ThreadTombstone | undefined>;
  readonly planEndUserItems: (operation: GovernanceOperation) => Promise<number>;
  readonly listItems: (
    operation: GovernanceOperation,
  ) => Promise<readonly ConversationErasureItem[]>;
  readonly fenceItem: (
    operation: GovernanceOperation,
    item: ConversationErasureItem,
  ) => Promise<FenceItemResult>;
  readonly replaceItem: (
    item: ConversationErasureItem,
    changes: Partial<
      Pick<
        ConversationErasureItem["data"],
        | "cancelRequestedAt"
        | "ingressRouteIds"
        | "recordsDeleted"
        | "runIds"
        | "stage"
        | "streamDeletedAt"
      >
    >,
  ) => Promise<ConversationErasureItem>;
  readonly listThreadRecords: (
    organizationId: string,
    threadId: string,
    cursor?: string,
  ) => Promise<TenantRecordPage>;
  readonly revokeStreamSessions: (sessions: readonly TenantRecord[]) => Promise<number>;
  readonly listIngressRouteRecords: (
    organizationId: string,
    ingressRouteId: string,
  ) => Promise<readonly TenantRecord[]>;
  readonly finalize: (operation: GovernanceOperation) => Promise<GovernanceOperation>;
  readonly planConversationMail: (
    operation: GovernanceOperation,
    item: ConversationErasureItem,
  ) => Promise<ConversationErasureItem>;
  readonly listMailItems: (
    operation: GovernanceOperation,
  ) => Promise<readonly ConversationErasureMailItem[]>;
  readonly replaceMailItem: (
    item: ConversationErasureMailItem,
    changes: Partial<
      Pick<ConversationErasureMailItem["data"], "messagesErased" | "pendingCleanupIds" | "stage">
    >,
  ) => Promise<ConversationErasureMailItem>;
  readonly sweepInboxThread: (
    operation: GovernanceOperation,
    item: ConversationErasureMailItem,
  ) => Promise<readonly FencedInboxMessage[]>;
  readonly prepareInboxMessageErasure: (
    operation: GovernanceOperation,
    message: FencedInboxMessage,
  ) => Promise<readonly TenantRecord[]>;
  readonly prepareInboxDraftErasure: (
    item: ConversationErasureMailItem,
  ) => Promise<readonly TenantRecord[]>;
  readonly finishInboxMessage: (
    item: ConversationErasureMailItem,
    message: FencedInboxMessage,
  ) => Promise<ConversationErasureMailItem>;
  readonly settleInboxThread: (
    item: ConversationErasureMailItem,
  ) => Promise<ConversationErasureMailItem>;
  readonly readRetentionCleanups: (
    organizationId: string,
    ids: readonly string[],
  ) => Promise<readonly RetentionCleanup[]>;
}
