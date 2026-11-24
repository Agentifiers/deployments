import type { DynamoDatabaseService, QueryRecordsResult } from "./client-types.ts";
import type { PlatformRecord } from "./records/index.ts";

/**
 * Keeps feature and runtime packages on an explicit, domain-named persistence
 * boundary. The generic Dynamo service is an implementation dependency of
 * these facades, never the API through which production features execute I/O.
 */
function makeDomainPersistenceFacade() {
  return {
    commit(
      database: DynamoDatabaseService,
      ...args: Parameters<DynamoDatabaseService["transactWrite"]>
    ) {
      return database.transactWrite(...args);
    },
    commitErasure(
      database: DynamoDatabaseService,
      ...args: Parameters<NonNullable<DynamoDatabaseService["transactWriteForErasure"]>>
    ) {
      const operation = database.transactWriteForErasure;
      if (!operation) {
        throw new Error("Erasure-aware transaction persistence is unavailable.");
      }
      return operation(...args);
    },
    find(
      database: DynamoDatabaseService,
      ...args: Parameters<DynamoDatabaseService["queryRecords"]>
    ): Promise<QueryRecordsResult> {
      return database.queryRecords(...args);
    },
    read(
      database: DynamoDatabaseService,
      ...args: Parameters<DynamoDatabaseService["getRecord"]>
    ): Promise<PlatformRecord | undefined> {
      return database.getRecord(...args);
    },
    remove(
      database: DynamoDatabaseService,
      ...args: Parameters<DynamoDatabaseService["deleteRecord"]>
    ) {
      return database.deleteRecord(...args);
    },
    supportsErasure(database: DynamoDatabaseService) {
      return database.transactWriteForErasure !== undefined;
    },
    write(
      database: DynamoDatabaseService,
      ...args: Parameters<DynamoDatabaseService["putRecord"]>
    ) {
      return database.putRecord(...args);
    },
  };
}

export const agentEmailPersistence = makeDomainPersistenceFacade();
export const apiPersistence = makeDomainPersistenceFacade();
export const brainRuntimePersistence = makeDomainPersistenceFacade();
export const browserScreenshotPersistence = makeDomainPersistenceFacade();
export const channelProviderPersistence = makeDomainPersistenceFacade();
export const memoryPersistence = makeDomainPersistenceFacade();
export const memoryRuntimePersistence = makeDomainPersistenceFacade();
export const modelUsagePersistence = makeDomainPersistenceFacade();
export const runtimeApiPersistence = makeDomainPersistenceFacade();
export const sandboxHostPersistence = makeDomainPersistenceFacade();
export const usagePersistence = makeDomainPersistenceFacade();
export const workerPersistence = makeDomainPersistenceFacade();
export const workflowRuntimePersistence = makeDomainPersistenceFacade();
