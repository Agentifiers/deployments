export interface BrainContentCleanupState {
  readonly bucket: string;
  readonly objectKey: string;
  readonly quiescenceStartedAt?: string;
  readonly status: "deleting" | "pending" | "verified";
  readonly verificationCount: number;
  readonly version: number;
}

export interface BrainContentVersionInventory {
  readonly deleteMarkers: readonly string[];
  readonly versionIds: readonly string[];
}

export interface BrainContentCleanupObjectStore {
  readonly deleteVersion: (input: {
    readonly bucket: string;
    readonly key: string;
    readonly versionId: string;
  }) => Promise<void>;
  readonly listExactKeyVersions: (input: {
    readonly bucket: string;
    readonly key: string;
  }) => Promise<BrainContentVersionInventory>;
}

const QUIESCENCE_MILLISECONDS = 60_000;

export async function advanceBrainContentCleanup(input: {
  readonly now: string;
  readonly objectStore: BrainContentCleanupObjectStore;
  readonly state: BrainContentCleanupState;
}): Promise<BrainContentCleanupState> {
  if (input.state.status === "verified") return input.state;
  const target = {
    bucket: input.state.bucket,
    key: input.state.objectKey,
  };
  const inventory = await input.objectStore.listExactKeyVersions(target);
  for (const versionId of [...inventory.versionIds, ...inventory.deleteMarkers]) {
    await input.objectStore.deleteVersion({ ...target, versionId });
  }
  const afterDeletion = await input.objectStore.listExactKeyVersions(target);
  if (afterDeletion.versionIds.length > 0 || afterDeletion.deleteMarkers.length > 0) {
    return {
      ...input.state,
      status: "deleting",
      verificationCount: 0,
      version: input.state.version + 1,
    };
  }
  if (!input.state.quiescenceStartedAt || input.state.verificationCount === 0) {
    return {
      ...input.state,
      quiescenceStartedAt: input.now,
      status: "deleting",
      verificationCount: 1,
      version: input.state.version + 1,
    };
  }
  if (
    Date.parse(input.now) <
    Date.parse(input.state.quiescenceStartedAt) + QUIESCENCE_MILLISECONDS
  ) {
    return input.state;
  }
  return {
    ...input.state,
    status: "verified",
    verificationCount: 2,
    version: input.state.version + 1,
  };
}
