import type { AwsNativeMemoryConfig, OpenSearchTransport } from "./aws-native-contracts.ts";
import {
  AWS_NATIVE_AUTOMATED_SNAPSHOT_RETENTION_HOURS,
  AWS_NATIVE_BACKUP_SAFETY_MARGIN_MINUTES,
} from "./aws-native-contracts.ts";
import {
  isMissingOpenSearchIndex,
  isOpenSearchIndexNotFound,
  requireNoOpenSearchSnapshotRepositories,
  requireCompleteOpenSearchDelete,
  requireOpenSearchDeletedDocumentsExpunged,
  requireOpenSearchMaintenanceComplete,
  requireOpenSearchOrganizationAbsent,
  requireOpenSearchStorageReclaimed,
} from "./aws-native-erasure.ts";

export async function purgeAwsNativeOrganization(args: {
  readonly config: AwsNativeMemoryConfig;
  readonly input: {
    readonly organizationId: string;
    readonly providerPurgeStartedAt?: string;
    readonly providerPurgeState?: Readonly<Record<string, unknown>>;
    readonly signal?: AbortSignal;
  };
  readonly now: () => Date;
  readonly openSearch: OpenSearchTransport;
}) {
  const { config, input, openSearch } = args;
  const observedAt = args.now();
  const startedAt = input.providerPurgeStartedAt
    ? new Date(input.providerPurgeStartedAt)
    : observedAt;
  if (!Number.isFinite(startedAt.getTime()) || startedAt.getTime() > observedAt.getTime()) {
    throw new TypeError("AWS-native provider purge start time is invalid.");
  }
  const providerPurgeStartedAt = startedAt.toISOString();
  const backupBoundary = (anchor: Date) =>
    new Date(
      anchor.getTime() +
        AWS_NATIVE_AUTOMATED_SNAPSHOT_RETENTION_HOURS * 60 * 60_000 +
        AWS_NATIVE_BACKUP_SAFETY_MARGIN_MINUTES * 60_000,
    ).toISOString();
  const state = input.providerPurgeState;
  const stage = state?.stage;
  if (
    stage !== undefined &&
    stage !== "delete-by-query" &&
    stage !== "force-merge" &&
    stage !== "backup-wait"
  ) {
    throw new TypeError("AWS-native provider purge state is invalid.");
  }
  const verifiedAtValue = stage === "backup-wait" ? state?.liveStorageVerifiedAt : undefined;
  const verifiedAt = typeof verifiedAtValue === "string" ? new Date(verifiedAtValue) : undefined;
  if (
    stage === "backup-wait" &&
    (!verifiedAt ||
      !Number.isFinite(verifiedAt.getTime()) ||
      verifiedAt.getTime() > observedAt.getTime())
  ) {
    throw new TypeError("AWS-native provider purge has no valid live-storage verification time.");
  }
  const provisionalBackupErasureEligibleAt = backupBoundary(startedAt);
  const pending = (
    providerPurgeState: Readonly<Record<string, unknown>>,
    openSearchResult: Readonly<Record<string, unknown>>,
    liveStorageVerified: boolean,
    backupErasureEligibleAt = provisionalBackupErasureEligibleAt,
  ) => ({
    deleted: false,
    receipt: {
      absenceVerified: false,
      backupErasureEligibleAt,
      liveStorageVerified,
      openSearch: openSearchResult,
      providerPurgeStartedAt: startedAt.toISOString(),
      providerPurgeState,
      snapshotInventoryVerified: liveStorageVerified,
    },
  });
  const completed = (
    openSearchResult: Readonly<Record<string, unknown>>,
    backupErasureEligibleAt: string,
  ) => ({
    deleted: true,
    receipt: {
      absenceVerified: true,
      backupErasureEligibleAt,
      liveStorageVerified: true,
      openSearch: openSearchResult,
      providerPurgeStartedAt,
      snapshotInventoryVerified: true,
    },
  });
  const missingIndexPending = () => {
    const liveStorageVerifiedAt = observedAt.toISOString();
    return pending(
      { liveStorageVerifiedAt, openSearchIndexAbsent: true, stage: "backup-wait" },
      { indexAlreadyAbsent: true },
      true,
      backupBoundary(observedAt),
    );
  };
  // A delete-by-query or force merge on a dropped index answers with a task instead of a 404.
  const submitStage = async (
    stage: "delete-by-query" | "force-merge",
    openSearchResult: { readonly taskSubmitted: true } | { readonly taskResubmitted: true },
  ) => {
    const index = `/${encodeURIComponent(config.openSearchIndex)}`;
    let submitted: unknown;
    try {
      await openSearch.request({
        method: "GET",
        path: index,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      submitted = await openSearch.request(
        stage === "delete-by-query"
          ? {
              body: { query: { term: { organizationId: input.organizationId } } },
              method: "POST",
              path: `${index}/_delete_by_query?conflicts=proceed&refresh=true&wait_for_completion=false`,
              ...(input.signal ? { signal: input.signal } : {}),
            }
          : {
              method: "POST",
              path: `${index}/_forcemerge?max_num_segments=1&flush=true&wait_for_completion=false`,
              ...(input.signal ? { signal: input.signal } : {}),
            },
      );
    } catch (cause) {
      if (!isOpenSearchIndexNotFound(cause)) throw cause;
      return missingIndexPending();
    }
    const taskId =
      submitted && typeof submitted === "object"
        ? (submitted as Readonly<Record<string, unknown>>).task
        : undefined;
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new Error(
        `OpenSearch ${stage === "delete-by-query" ? "delete-by-query" : "force merge"} returned no durable task ID.`,
      );
    }
    return pending({ stage, taskId }, openSearchResult, false);
  };
  // OpenSearch removed typed document paths; `/.tasks/task/<id>` answers 400 "no handler found".
  const deleteTaskResult = async (taskId: string) => {
    try {
      const deleted = await openSearch.request({
        method: "DELETE",
        path: `/.tasks/_doc/${encodeURIComponent(taskId)}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (
        !deleted ||
        typeof deleted !== "object" ||
        !["deleted", "not_found"].includes(
          String((deleted as Readonly<Record<string, unknown>>).result),
        )
      ) {
        throw new Error("OpenSearch task result deletion was not acknowledged.");
      }
    } catch (cause) {
      if (!isMissingOpenSearchIndex(cause)) throw cause;
    }
  };

  if (!stage) return submitStage("delete-by-query", { taskSubmitted: true });

  let openSearchResult: Readonly<Record<string, unknown>> = { backupWait: true };
  if (stage === "delete-by-query") {
    const taskId = state.taskId;
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new TypeError("AWS-native delete checkpoint has no task ID.");
    }
    let task: unknown;
    try {
      task = await openSearch.request({
        method: "GET",
        path: `/_tasks/${encodeURIComponent(taskId)}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (cause) {
      if (!isMissingOpenSearchIndex(cause)) throw cause;
      return submitStage("delete-by-query", { taskResubmitted: true });
    }
    if (!task || typeof task !== "object") {
      throw new Error("OpenSearch delete task response is invalid.");
    }
    const taskResult = task as Readonly<Record<string, unknown>>;
    if (taskResult.error) {
      await deleteTaskResult(taskId);
      return submitStage("delete-by-query", { taskResubmitted: true });
    }
    if (taskResult.completed !== true) return pending(state, { taskPending: true }, false);
    try {
      requireCompleteOpenSearchDelete(taskResult.response);
    } catch {
      await deleteTaskResult(taskId);
      return submitStage("delete-by-query", { taskResubmitted: true });
    }
    await deleteTaskResult(taskId);
    return submitStage("force-merge", { taskSubmitted: true });
  }
  if (stage === "force-merge") {
    const taskId = state.taskId;
    if (typeof taskId !== "string" || taskId.length === 0) {
      throw new TypeError("AWS-native force-merge checkpoint has no task ID.");
    }
    let task: unknown;
    try {
      task = await openSearch.request({
        method: "GET",
        path: `/_tasks/${encodeURIComponent(taskId)}`,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (cause) {
      if (!isMissingOpenSearchIndex(cause)) throw cause;
      return submitStage("force-merge", { taskResubmitted: true });
    }
    if (!task || typeof task !== "object") {
      throw new Error("OpenSearch force-merge task response is invalid.");
    }
    const taskResult = task as Readonly<Record<string, unknown>>;
    if (taskResult.error) {
      await deleteTaskResult(taskId);
      return submitStage("force-merge", { taskResubmitted: true });
    }
    if (taskResult.completed !== true) {
      return pending(state, { taskPending: true }, false);
    }
    try {
      requireOpenSearchMaintenanceComplete(taskResult.response, "force merge");
    } catch {
      await deleteTaskResult(taskId);
      return submitStage("force-merge", { taskResubmitted: true });
    }
    await deleteTaskResult(taskId);
    openSearchResult = { taskCompleted: true };
  } else if (observedAt.getTime() < Date.parse(backupBoundary(verifiedAt!))) {
    return pending(state, { backupWait: true }, true, backupBoundary(verifiedAt!));
  }
  if (stage === "backup-wait" && state.openSearchIndexAbsent === true) {
    return completed({ indexAlreadyAbsent: true }, backupBoundary(verifiedAt!));
  }

  try {
    const segments = await openSearch.request({
      method: "GET",
      path: `/${encodeURIComponent(config.openSearchIndex)}/_segments`,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    requireOpenSearchDeletedDocumentsExpunged(segments, config.openSearchIndex);
    const flush = await openSearch.request({
      method: "POST",
      path: `/${encodeURIComponent(config.openSearchIndex)}/_flush?force=true&wait_if_ongoing=true`,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    requireOpenSearchMaintenanceComplete(flush, "flush");
    const storage = await openSearch.request({
      method: "GET",
      path: `/${encodeURIComponent(config.openSearchIndex)}/_stats/segments,translog?level=indices`,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    requireOpenSearchStorageReclaimed(storage, config.openSearchIndex);
    const snapshotRepositories = await openSearch.request({
      method: "GET",
      path: "/_snapshot/_all",
      ...(input.signal ? { signal: input.signal } : {}),
    });
    requireNoOpenSearchSnapshotRepositories(snapshotRepositories);
    const absence = await openSearch.request({
      body: {
        query: { term: { organizationId: input.organizationId } },
        size: 0,
        track_total_hits: true,
      },
      method: "POST",
      path: `/${encodeURIComponent(config.openSearchIndex)}/_search`,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    requireOpenSearchOrganizationAbsent(absence);
  } catch (cause) {
    if (!isMissingOpenSearchIndex(cause)) throw cause;
    return missingIndexPending();
  }
  const liveStorageVerifiedAt = verifiedAt ?? args.now();
  const backupErasureEligibleAt = backupBoundary(liveStorageVerifiedAt);
  const backupExpired = args.now().getTime() >= Date.parse(backupErasureEligibleAt);
  if (!backupExpired) {
    return pending(
      { liveStorageVerifiedAt: liveStorageVerifiedAt.toISOString(), stage: "backup-wait" },
      openSearchResult,
      true,
      backupErasureEligibleAt,
    );
  }
  return completed(openSearchResult, backupErasureEligibleAt);
}
