import {
  identityEmailDeliveryBinding,
  withCanonicalRecordKeys,
  type IdentityRecord,
  type IdentityRepository,
  type PlatformRecord,
  type ProtectedEnvelope,
} from "@deployments-ai/db";
import {
  identityEmailMessage,
  type IdentityEmailMessageDependencies,
  type IdentityEmailPayload,
  type RenderedIdentityEmail,
} from "./delivery-message.ts";

type Delivery = IdentityRecord<"identity-email-delivery">;
type ActiveDeliveryData = Extract<Delivery["data"], { readonly status: "pending" | "queued" }>;

/** Drops the dispatch-scheduling field owned by the active state, keeping the shared fields. */
function withoutDispatchState(data: ActiveDeliveryData) {
  if (data.status === "pending") {
    const { nextDispatchAt: _next, ...remaining } = data;
    return remaining;
  }
  const { queuedAt: _queued, ...remaining } = data;
  return remaining;
}

export interface IdentityEmailQueueEvent {
  readonly Records?: readonly {
    readonly attributes?: Readonly<Record<string, string | undefined>>;
    readonly body?: string;
    readonly messageId?: string;
  }[];
}

export interface IdentityEmailWorkerDependencies extends IdentityEmailMessageDependencies {
  readonly decrypt: <Value>(
    envelope: ProtectedEnvelope,
    binding: Readonly<Record<string, string>>,
  ) => Promise<Value>;
  readonly maxReceiveCount: number;
  readonly now: () => Date;
  readonly repository: IdentityRepository;
  readonly send: (email: {
    readonly content: RenderedIdentityEmail;
    readonly recipient: string;
  }) => Promise<void>;
}

/** SQS handler: load, revalidate, render, send, then settle each identity email delivery. */
export function makeIdentityEmailWorkerHandler(dependencies: IdentityEmailWorkerDependencies) {
  const { repository } = dependencies;

  async function settle(delivery: Delivery, data: Readonly<Record<string, unknown>>) {
    await repository.transact([
      {
        kind: "put",
        previousRecord: delivery,
        record: withCanonicalRecordKeys({
          ...delivery,
          data: { ...data, version: delivery.data.version + 1 },
        }) as PlatformRecord,
      },
    ]);
  }

  async function discard(delivery: Delivery, failureCategory: string) {
    if (delivery.data.status !== "pending" && delivery.data.status !== "queued") return;
    const { protectedPayload: _payload, ...remaining } = withoutDispatchState(delivery.data);
    const failedAt = dependencies.now().toISOString();
    await settle(delivery, {
      ...remaining,
      failedAt,
      failureCategory,
      status: "discarded",
      updatedAt: failedAt,
    });
  }

  async function markFailed(delivery: Delivery, receiveCount: number) {
    if (delivery.data.status !== "pending" && delivery.data.status !== "queued") return;
    const remaining = withoutDispatchState(delivery.data);
    const failedAt = dependencies.now().toISOString();
    await settle(delivery, {
      ...remaining,
      attemptCount: Math.max(delivery.data.attemptCount, receiveCount),
      failedAt,
      failureCategory: "delivery-attempts-exhausted",
      lastAttemptAt: failedAt,
      status: "failed",
      updatedAt: failedAt,
    });
  }

  return async function handler(event: IdentityEmailQueueEvent) {
    const failures: { itemIdentifier: string }[] = [];
    for (const message of event.Records ?? []) {
      let delivery: Delivery | undefined;
      try {
        if (!message.body) continue;
        delivery = await repository.deliveryForId(message.body);
        if (
          !delivery ||
          (delivery.data.status !== "pending" && delivery.data.status !== "queued")
        ) {
          continue;
        }
        const now = dependencies.now();
        if (Date.parse(delivery.data.expiresAt) <= now.getTime()) {
          await discard(delivery, "delivery-expired");
          continue;
        }
        const payload = await dependencies.decrypt<IdentityEmailPayload>(
          delivery.data.protectedPayload,
          identityEmailDeliveryBinding(delivery.data),
        );
        const outcome = await identityEmailMessage(delivery, payload, dependencies, now);
        if (outcome.kind === "discard") {
          await discard(delivery, outcome.failureCategory);
          continue;
        }
        await dependencies.send({ content: outcome.content, recipient: outcome.recipient });
        const { protectedPayload: _payload, ...rest } = withoutDispatchState(delivery.data);
        const sentAt = dependencies.now().toISOString();
        await settle(delivery, { ...rest, sentAt, status: "sent", updatedAt: sentAt });
      } catch {
        const receiveCount = Number(message.attributes?.ApproximateReceiveCount ?? "1");
        if (delivery && Date.parse(delivery.data.expiresAt) <= dependencies.now().getTime()) {
          await discard(delivery, "delivery-expired").catch(() => undefined);
        } else if (delivery && receiveCount >= dependencies.maxReceiveCount) {
          await markFailed(delivery, receiveCount).catch(() => undefined);
        }
        if (message.messageId) failures.push({ itemIdentifier: message.messageId });
      }
    }
    return { batchItemFailures: failures };
  };
}
