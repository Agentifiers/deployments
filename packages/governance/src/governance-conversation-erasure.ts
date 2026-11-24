import {
  CONVERSATION_ERASURE_PHASES,
  type ConversationErasureCounts,
  type ConversationErasureItem,
  type ConversationErasurePhase,
  type GovernanceOperation,
  type PlatformRecord,
  type RetentionCleanup,
  type TenantRecord,
} from "@deployments-ai/db";
import { eraseConversationMail } from "./governance-conversation-mail-erasure.ts";
import { eraseObservability } from "./governance-observability-erasure.ts";
import { makeRetentionInventory } from "./governance-retention-inventory.ts";
import {
  allTenantRecords,
  blobReferences,
  completeRetentionCleanups,
  distinctTenantRecords,
  stageExpiredRecords,
} from "./governance-service-support.ts";
import {
  GovernanceError,
  type ConversationErasurePorts,
  type GovernanceServiceOptions,
} from "./types.ts";

const INVENTORY_INDEX_LAG_MILLISECONDS = 5 * 60_000;
const RUN_CANCEL_DEADLINE_MILLISECONDS = 60 * 60_000;
const MEMORY_PURGE_BATCH_SIZE = 100;
const MAX_CANONICAL_PASSES = 20;

const WAIT_CODES: Readonly<Record<string, true>> = {
  conversation_canonical_pending: true,
  conversation_canonical_settling: true,
  conversation_mail_pending: true,
  conversation_objects_pending: true,
  conversation_runs_active: true,
  observability_erasure_pending: true,
};
const FAILURE_CODES: Readonly<Record<string, true>> = { conversation_runs_active_timeout: true };

type IngressRecord = Extract<
  PlatformRecord,
  {
    readonly itemType:
      | "channel-ingress-burst"
      | "channel-ingress-burst-head"
      | "channel-ingress-source";
  }
>;
type RunId = ConversationErasureItem["data"]["runIds"][number];

function waitFor(code: string, message: string): never {
  throw new GovernanceError(code, message);
}

function isIngressRecord(record: PlatformRecord): record is IngressRecord {
  return (
    record.itemType === "channel-ingress-burst" ||
    record.itemType === "channel-ingress-burst-head" ||
    record.itemType === "channel-ingress-source"
  );
}

export async function runConversationErasure(
  context: {
    readonly now: () => Date;
    readonly options: GovernanceServiceOptions;
  },
  claimed: GovernanceOperation,
): Promise<GovernanceOperation> {
  const { now, options } = context;
  const { organizationId } = claimed;
  const leaseDeadline = claimed.leaseExpiresAt ?? now().toISOString();
  let current = claimed;
  if (!current.conversationErasure) {
    throw new GovernanceError("operation_invalid", "Conversation erasure state is missing.");
  }
  const counts: { -readonly [Key in keyof ConversationErasureCounts]: number } = {
    ...current.conversationErasure.counts,
  };
  const withCounts = (): GovernanceOperation => ({
    ...current,
    conversationErasure: { ...current.conversationErasure!, counts: { ...counts } },
  });

  try {
    const ports: ConversationErasurePorts =
      options.conversationErasure ??
      waitFor(
        "conversation_erasure_unavailable",
        "Thread and end-user erasure is not configured on this worker.",
      );
    const { store } = ports;

    const remember = async (item: ConversationErasureItem, records: readonly TenantRecord[]) => {
      const runIds = new Set<RunId>(item.data.runIds);
      const ingressRouteIds = new Set(item.data.ingressRouteIds);
      for (const { record } of records) {
        if (record.itemType === "run") runIds.add(record.data.id);
        if (record.itemType === "inbound-thread-route" && record.data.ingressRouteId) {
          ingressRouteIds.add(record.data.ingressRouteId);
        }
      }
      if (
        runIds.size === item.data.runIds.length &&
        ingressRouteIds.size === item.data.ingressRouteIds.length
      ) {
        return item;
      }
      return store.replaceItem(item, {
        ingressRouteIds: [...ingressRouteIds].sort(),
        runIds: [...runIds].sort(),
      });
    };

    const eachThreadPage = async (
      item: ConversationErasureItem,
      visit: (records: readonly TenantRecord[]) => Promise<void>,
    ) => {
      const unseen = distinctTenantRecords();
      let cursor: string | undefined;
      do {
        const page = await store.listThreadRecords(organizationId, item.data.threadId, cursor);
        cursor = page.cursor;
        await visit(unseen(page.items));
      } while (cursor);
    };

    const pendingCleanups = async (items: readonly ConversationErasureItem[]) => {
      const cleanups: RetentionCleanup[] = [];
      for (const item of items) {
        await eachThreadPage(item, async (records) => {
          for (const { record } of records) {
            if (record.itemType === "retention-cleanup") cleanups.push(record.data);
          }
        });
      }
      return cleanups;
    };

    const phases: Record<
      Exclude<ConversationErasurePhase, "finalizing">,
      (items: readonly ConversationErasureItem[]) => Promise<void>
    > = {
      async planning() {
        counts.threadsPlanned = await store.planEndUserItems(current);
      },
      async mail(items) {
        const erased = await eraseConversationMail(
          { leaseDeadline, now, operation: current, options, store },
          items,
        );
        counts.emailMessagesErased = erased.emailMessagesErased;
        counts.emailThreadsErased = erased.emailThreadsErased;
      },
      async fencing(items) {
        let runsActive = false;
        for (const item of items) {
          const fenced = await store.fenceItem(current, item);
          if (fenced.kind === "fenced") continue;
          const requestedAt = item.data.cancelRequestedAt;
          if (
            requestedAt &&
            Date.parse(requestedAt) + RUN_CANCEL_DEADLINE_MILLISECONDS <= now().getTime()
          ) {
            throw new GovernanceError(
              "conversation_runs_active_timeout",
              "Runs of an erased thread did not stop within an hour of cancellation.",
            );
          }
          for (const run of fenced.runs) {
            await ports.cancelRun({ actorId: current.requestedByPrincipalId, run });
            counts.runsCanceled += 1;
          }
          const marked = requestedAt
            ? item
            : await store.replaceItem(item, { cancelRequestedAt: now().toISOString() });
          if ((await store.fenceItem(current, marked)).kind === "runs-active") runsActive = true;
        }
        if (runsActive) {
          waitFor("conversation_runs_active", "Waiting for canceled runs of erased threads.");
        }
      },
      async automations(items) {
        let archived = 0;
        for (let item of items) {
          await eachThreadPage(item, async (records) => {
            item = await remember(item, records);
            for (const { record } of records) {
              if (record.itemType !== "schedule" && record.itemType !== "heartbeat") continue;
              await ports.deleteAutomationTimer(record.data.id);
              archived += 1;
            }
          });
        }
        counts.automationsArchived = archived;
      },
      async memory(items) {
        let erased = 0;
        for (const item of items) {
          const memories: { readonly pk: string; readonly sk: string }[] = [];
          await eachThreadPage(item, async (records) => {
            for (const { record } of records) {
              if (record.itemType === "memory") memories.push({ pk: record.pk, sk: record.sk });
            }
          });
          for (let offset = 0; offset < memories.length; offset += MEMORY_PURGE_BATCH_SIZE) {
            await ports.purgeThreadMemories({
              memories: memories.slice(offset, offset + MEMORY_PURGE_BATCH_SIZE),
              operationId: current.id,
              organizationId,
              threadId: item.data.threadId,
            });
          }
          erased += memories.length;
        }
        counts.memoriesErased = erased;
      },
      async canonical(items) {
        let settling = false;
        let recordsDeleted = 0;
        for (let item of items) {
          for (let pass = 1; item.data.stage !== "erased"; pass += 1) {
            let found = 0;
            let unstaged = 0;
            await eachThreadPage(item, async (page) => {
              const records = page.filter(({ record }) => record.itemType !== "retention-cleanup");
              if (records.length === 0) return;
              found += records.length;
              item = await remember(item, records);
              await store.revokeStreamSessions(
                records.filter(({ record }) => record.itemType === "stream-session"),
              );
              const holders = records.filter(
                ({ record }) => blobReferences(options, organizationId, record, true).length > 0,
              );
              const plain = records.filter((record) => !holders.includes(record));
              const staged = await stageExpiredRecords(
                options,
                organizationId,
                holders,
                now().toISOString(),
              );
              await options.store.deleteTenantRecords(plain, leaseDeadline);
              unstaged += holders.length - staged.length;
              counts.objectsStaged += staged.length;
              item = await store.replaceItem(item, {
                recordsDeleted: item.data.recordsDeleted + staged.length + plain.length,
              });
            });
            if (unstaged > 0) {
              waitFor(
                "conversation_canonical_pending",
                "Some records of an erased thread changed while they were being staged.",
              );
            }
            if (found > 0) {
              if (pass >= MAX_CANONICAL_PASSES) {
                waitFor(
                  "conversation_canonical_pending",
                  "Records of an erased thread are still appearing.",
                );
              }
              continue;
            }
            const fencedAt = Date.parse(item.data.fencedAt ?? item.data.createdAt);
            if (fencedAt + INVENTORY_INDEX_LAG_MILLISECONDS > now().getTime()) {
              settling = true;
              break;
            }
            item = await store.replaceItem(item, { stage: "erased" });
          }
          recordsDeleted += item.data.recordsDeleted;
        }
        if (settling) {
          waitFor(
            "conversation_canonical_settling",
            "The thread inventory is re-read once the erasure fence has settled.",
          );
        }
        counts.recordsDeleted = recordsDeleted;
        counts.threadsErased = items.length;
      },
      async ingress(items) {
        for (const item of items) {
          const fencedAt = Date.parse(item.data.fencedAt ?? item.data.createdAt);
          for (const ingressRouteId of item.data.ingressRouteIds) {
            const before = (
              await store.listIngressRouteRecords(organizationId, ingressRouteId)
            ).filter(
              ({ record }) =>
                isIngressRecord(record) &&
                Date.parse(
                  record.itemType === "channel-ingress-burst-head"
                    ? record.data.updatedAt
                    : record.data.createdAt,
                ) <= fencedAt,
            );
            await options.store.deleteTenantRecords(before, leaseDeadline);
            counts.ingressRecordsDeleted += before.length;
          }
        }
      },
      async streams(items) {
        for (const item of items) {
          if (item.data.streamDeletedAt) continue;
          await ports.deleteThreadStream({
            environmentId: item.data.environmentId,
            organizationId,
            projectId: item.data.projectId,
            threadId: item.data.threadId,
          });
          await store.replaceItem(item, { streamDeletedAt: now().toISOString() });
        }
        counts.streamsDeleted = items.length;
      },
      async objects(items) {
        const cleanups = await pendingCleanups(items);
        if (cleanups.length === 0) return;
        const observedAt = now().toISOString();
        const inventory = makeRetentionInventory("cleanup-only", Date.parse(observedAt));
        await allTenantRecords(options, organizationId, inventory.selection);
        const holders = inventory.liveObjectHolders(cleanups, new Set());
        const liveRecords = holders ? await allTenantRecords(options, organizationId, holders) : [];
        await completeRetentionCleanups(options, organizationId, cleanups, liveRecords, observedAt);
        if ((await pendingCleanups(items)).length > 0) {
          waitFor("conversation_objects_pending", "Objects of erased threads are still pending.");
        }
      },
      async observability(items) {
        await eraseObservability({
          checkpoint: (updated) => {
            current = updated;
          },
          now,
          operation: withCounts(),
          purgeObservability: options.purgeObservability,
          scope: {
            kind: "conversation",
            runIds: [...new Set(items.flatMap((item) => item.data.runIds))].sort(),
            threadIds: items.map((item) => item.data.threadId).sort(),
          },
          store: options.store,
        });
      },
    };

    for (
      let phase = current.conversationErasure!.phase;
      phase !== "finalizing";
      phase = current.conversationErasure!.phase
    ) {
      await phases[phase](await store.listItems(current));
      const next = CONVERSATION_ERASURE_PHASES[CONVERSATION_ERASURE_PHASES.indexOf(phase) + 1]!;
      const advancedAt = now().toISOString();
      const advanced = withCounts();
      current = await options.store.updateOperation(
        {
          ...advanced,
          ...(phase === "canonical" ? { canonicalDeletedAt: advancedAt } : {}),
          conversationErasure: { ...advanced.conversationErasure!, phase: next },
          updatedAt: advancedAt,
          version: current.version + 1,
        },
        current.version,
      );
    }
    return await store.finalize(withCounts());
  } catch (cause) {
    const code = cause instanceof GovernanceError ? cause.code : "governance_operation_failed";
    const { leaseExpiresAt: _leaseExpiresAt, ...unleased } = withCounts();
    const updated = await options.store.updateOperation(
      {
        ...unleased,
        error: { code, message: cause instanceof Error ? cause.message : String(cause) },
        status: FAILURE_CODES[code] ? "failed" : "pending",
        updatedAt: now().toISOString(),
        version: current.version + 1,
      },
      current.version,
    );
    if (WAIT_CODES[code]) return updated;
    throw cause;
  }
}
