import {
  isDatabaseWriteConflict,
  withCanonicalRecordKeys,
  type IdentityRecord,
  type IdentityRepository,
} from "@deployments-ai/db";

const QUEUED_WRITE_ATTEMPTS = 5;

export async function queueIdentityEmailDelivery(input: {
  readonly now?: () => Date;
  readonly record: IdentityRecord<"identity-email-delivery">;
  readonly repository: IdentityRepository;
  readonly send: (deliveryId: string, dispatchShard: string) => Promise<void>;
}) {
  const observed = await input.repository.deliveryForId(input.record.data.id);
  if (!observed || observed.data.status !== "pending") return;
  await input.send(observed.data.id, observed.data.dispatchShard);
  let current = observed;
  let lastConflict: unknown;
  for (let attempt = 0; attempt < QUEUED_WRITE_ATTEMPTS; attempt += 1) {
    if (current.data.status !== "pending") return;
    const { nextDispatchAt: _next, ...remaining } = current.data;
    const queuedAt = (input.now ?? (() => new Date()))().toISOString();
    const queued = withCanonicalRecordKeys({
      ...current,
      data: {
        ...remaining,
        queuedAt,
        status: "queued" as const,
        updatedAt: queuedAt,
        version: current.data.version + 1,
      },
    });
    try {
      await input.repository.transact([{ kind: "put", previousRecord: current, record: queued }]);
      return;
    } catch (error) {
      if (!isDatabaseWriteConflict(error)) throw error;
      lastConflict = error;
      const observed = await input.repository.deliveryForId(input.record.data.id);
      if (!observed) throw error;
      current = observed;
    }
  }
  throw lastConflict;
}
