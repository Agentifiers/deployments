import type { AppRole } from "./names.ts";

export interface AppDatabaseLimits {
  readonly graceMs: number;
  readonly migrateDeadlineMs: number;
  readonly queryDeadlineMs: number;
  readonly describeDeadlineMs: number;
  readonly exportDeadlineMs: number;
  readonly apiDeadlineMs: number;
  readonly apiLockTimeout: string;
  readonly apiWorkMem: string;
  readonly apiResultMaxBytes: number;
  readonly maxConnectionsPerPool: Readonly<Record<AppRole, number>>;
  readonly maxConnectionsTotal: number;
  readonly connectionWaitMs: number;
}

export const DEFAULT_LIMITS: AppDatabaseLimits = {
  apiDeadlineMs: 5_000,
  apiLockTimeout: "2s",
  apiResultMaxBytes: 1_048_576,
  apiWorkMem: "16MB",
  connectionWaitMs: 3_000,
  describeDeadlineMs: 30_000,
  exportDeadlineMs: 240_000,
  graceMs: 2_000,
  maxConnectionsPerPool: { editor: 4, owner: 4, viewer: 4, visitor: 2 },
  maxConnectionsTotal: 64,
  migrateDeadlineMs: 60_000,
  queryDeadlineMs: 15_000,
};
