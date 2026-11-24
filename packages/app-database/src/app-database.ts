import { ApiFunctionCaller, type ApiCallInput, type ApiCallResult } from "./api-call.ts";
import type { ConnectionSettings } from "./connection.ts";
import { describe } from "./describe.ts";
import { erase, type EraseInput } from "./erase.ts";
import { exportTables, type ExportInput } from "./export.ts";
import { DEFAULT_LIMITS, type AppDatabaseLimits } from "./limits.ts";
import { migrate, type MigrateInput } from "./migrate.ts";
import type { AppId } from "./names.ts";
import type { AppObjectStore, SlugDirectory } from "./ports.ts";
import type {
  AppDescription,
  EraseResult,
  ExportResult,
  MigrateResult,
  ProvisionResult,
  QueryResult,
} from "./protocol.ts";
import { provision, type ProvisionInput } from "./provision.ts";
import { query, type QueryInput } from "./query.ts";
import { AppConnectionPools } from "./session.ts";

export interface AppDatabaseControl {
  readonly provision: (input: ProvisionInput) => Promise<ProvisionResult>;
  readonly migrate: (input: MigrateInput) => Promise<MigrateResult>;
  readonly query: (input: QueryInput) => Promise<QueryResult>;
  readonly describe: (appId: AppId) => Promise<AppDescription>;
  readonly exportTables: (input: ExportInput) => Promise<ExportResult>;
  readonly erase: (input: EraseInput) => Promise<EraseResult>;
  readonly close: () => Promise<void>;
}

export function createAppDatabaseControl(dependencies: {
  readonly connections: ConnectionSettings;
  readonly slugDirectory: SlugDirectory;
  readonly objectStore: AppObjectStore;
  readonly limits?: Partial<AppDatabaseLimits>;
}): AppDatabaseControl {
  const limits = { ...DEFAULT_LIMITS, ...dependencies.limits };
  const pools = new AppConnectionPools(dependencies.connections, limits);
  const context = { limits, objectStore: dependencies.objectStore, pools };
  return {
    close: () => pools.close(),
    describe: (appId) => describe(context, appId),
    erase: async (input) => {
      await pools.closeApp(input.appId);
      return erase(dependencies, input);
    },
    exportTables: (input) => exportTables(context, input),
    migrate: (input) => migrate(context, input),
    provision: (input) => provision(dependencies, input),
    query: (input) => query(context, input),
  };
}

export interface AppApiGateway {
  readonly callApiFunction: (input: ApiCallInput) => Promise<ApiCallResult>;
  readonly close: () => Promise<void>;
}

export function createAppApiGateway(dependencies: {
  readonly connections: ConnectionSettings;
  readonly limits?: Partial<AppDatabaseLimits>;
}): AppApiGateway {
  const limits = { ...DEFAULT_LIMITS, ...dependencies.limits };
  const pools = new AppConnectionPools(dependencies.connections, limits);
  const caller = new ApiFunctionCaller(pools, limits);
  return {
    callApiFunction: (input) => caller.call(input),
    close: () => pools.close(),
  };
}
