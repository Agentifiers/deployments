import type { DynamoDatabaseService, TransactionOperation } from "../client-types.ts";
import {
  createBrainRecordOperations as createClaimedRecordOperations,
  updateBrainRecordOperations as updateClaimedRecordOperations,
} from "../brains/record-operations.ts";
import { key } from "../keys.ts";
import {
  DatasetCaseRecord,
  MAX_EVALUATION_DATASET_CASES,
  RegressionDatasetRecord,
} from "../records/evaluations.ts";
import { uniqueClaimRequirements } from "../unique-claims.ts";
import {
  canonicalRecord,
  commitWithEvent,
  conflict,
  invalidInput,
  nextRecordVersion,
  notFound,
  queryAllScoped,
  queryScopedPage,
  readScopedRecord,
  runDatabase,
  type EvaluationPage,
  type EvaluationPageOptions,
  type EvaluationPersistenceEvent,
  type EvaluationScope,
} from "./support.ts";

export type RegressionDatasetData = RegressionDatasetRecord["data"];
export type DatasetCaseData = DatasetCaseRecord["data"];

/** Cases per transaction: each case writes a record, a content claim, and directory entries. */
export const MAX_DATASET_CASES_PER_WRITE = 20;

export interface AddDatasetCasesResult {
  readonly created: readonly DatasetCaseRecord[];
  readonly dataset: RegressionDatasetRecord;
  /** Cases whose content already existed in the dataset (content-addressed idempotency). */
  readonly existing: readonly DatasetCaseRecord[];
}

export interface RegressionDatasetPersistence {
  readonly createRegressionDataset: (
    data: RegressionDatasetData,
    event: EvaluationPersistenceEvent,
  ) => Promise<RegressionDatasetRecord>;
  readonly archiveRegressionDataset: (
    input: { readonly archivedAt: string; readonly datasetId: string },
    event: EvaluationPersistenceEvent,
  ) => Promise<RegressionDatasetRecord>;
  readonly getRegressionDataset: (id: string) => Promise<RegressionDatasetRecord | undefined>;
  readonly listRegressionDatasets: (
    options: EvaluationPageOptions & { readonly status?: RegressionDatasetData["status"] },
  ) => Promise<EvaluationPage<RegressionDatasetRecord>>;
  /** Returns existing cases for content already in the dataset without writing them again. */
  readonly findDatasetCasesByContent: (
    datasetId: string,
    contentSha256s: readonly string[],
  ) => Promise<ReadonlyMap<string, DatasetCaseRecord>>;
  readonly addDatasetCases: (
    input: {
      readonly cases: readonly DatasetCaseData[];
      readonly datasetId: string;
      readonly updatedAt: string;
    },
    event: EvaluationPersistenceEvent,
  ) => Promise<AddDatasetCasesResult>;
  readonly getDatasetCase: (
    datasetId: string,
    caseId: string,
  ) => Promise<DatasetCaseRecord | undefined>;
  readonly listDatasetCases: (
    datasetId: string,
    options: EvaluationPageOptions,
  ) => Promise<EvaluationPage<DatasetCaseRecord>>;
  readonly listAllDatasetCases: (datasetId: string) => Promise<readonly DatasetCaseRecord[]>;
}

export function makeRegressionDatasetPersistence(
  database: DynamoDatabaseService,
  scope: EvaluationScope,
): RegressionDatasetPersistence {
  const environmentPartition = key("ORG", scope.organizationId, "ENV", scope.environmentId);
  const datasetPartition = (datasetId: string) =>
    key("ORG", scope.organizationId, "DATASET", datasetId);
  const datasetRecord = (data: RegressionDatasetData) =>
    canonicalRecord(RegressionDatasetRecord, { data, itemType: "regression-dataset" });

  const getRegressionDataset = (id: string) =>
    readScopedRecord(
      database,
      scope,
      "control",
      { pk: environmentPartition, sk: key("REGRESSION-DATASET", id) },
      "regression-dataset",
    );

  const getDatasetCase = (datasetId: string, caseId: string) =>
    readScopedRecord(
      database,
      scope,
      "control",
      { pk: datasetPartition(datasetId), sk: key("DATASET-CASE", caseId) },
      "dataset-case",
    );

  async function existingCaseForContent(datasetId: string, contentSha256: string) {
    const claim = await runDatabase(
      "dataset case claim read",
      database.getRecord(
        "control",
        {
          pk: key("UNIQUE", `regression-dataset:${datasetId}:case-content`),
          sk: key("VALUE", contentSha256),
        },
        true,
      ),
    );
    if (claim?.itemType !== "unique-claim" || claim.data.ownerItemType !== "dataset-case") {
      return undefined;
    }
    if (claim.data.ownerPk !== datasetPartition(datasetId)) return undefined;
    return getDatasetCase(datasetId, claim.data.ownerId);
  }

  async function findDatasetCasesByContent(datasetId: string, contentSha256s: readonly string[]) {
    const found = new Map<string, DatasetCaseRecord>();
    for (const contentSha256 of new Set(contentSha256s)) {
      const existing = await existingCaseForContent(datasetId, contentSha256);
      if (existing) found.set(contentSha256, existing);
    }
    return found;
  }

  return {
    async createRegressionDataset(data, event) {
      const dataset = datasetRecord(data);
      if (
        dataset.data.version !== 1 ||
        dataset.data.status !== "active" ||
        dataset.data.caseCount !== 0
      ) {
        invalidInput(
          "invalid_regression_dataset",
          "New regression datasets start active and empty at version 1.",
        );
      }
      await commitWithEvent(
        database,
        scope,
        createClaimedRecordOperations(dataset, dataset.data.createdAt),
        {
          aggregateId: dataset.data.id,
          aggregateType: "regression_dataset",
          aggregateVersion: dataset.data.version,
          event,
        },
        "regression dataset create",
      );
      return dataset;
    },

    async archiveRegressionDataset(input, event) {
      const previous = await getRegressionDataset(input.datasetId);
      if (!previous) notFound("regression_dataset_not_found", "Regression dataset not found.");
      if (previous.data.status === "archived") return previous;
      const dataset = nextRecordVersion(
        previous,
        datasetRecord({
          ...previous.data,
          archivedAt: input.archivedAt,
          status: "archived",
          updatedAt: input.archivedAt,
          version: previous.data.version + 1,
        }),
      );
      await commitWithEvent(
        database,
        scope,
        updateClaimedRecordOperations(previous, dataset, input.archivedAt),
        {
          aggregateId: dataset.data.id,
          aggregateType: "regression_dataset",
          aggregateVersion: dataset.data.version,
          event,
        },
        "regression dataset archive",
      );
      return dataset;
    },

    getRegressionDataset,

    listRegressionDatasets: (options) =>
      queryScopedPage(database, scope, {
        index: "gsi2",
        itemType: "regression-dataset",
        newestFirst: true,
        options,
        partition: key("ENV", scope.environmentId),
        prefix: `${options.status ? key("REGRESSION-DATASET", options.status) : "REGRESSION-DATASET"}#`,
        table: "control",
      }),

    findDatasetCasesByContent,

    async addDatasetCases(input, event) {
      if (input.cases.length === 0 || input.cases.length > MAX_DATASET_CASES_PER_WRITE) {
        invalidInput(
          "invalid_dataset_case_batch",
          `Dataset case writes accept 1 to ${MAX_DATASET_CASES_PER_WRITE} cases.`,
        );
      }
      const previous = await getRegressionDataset(input.datasetId);
      if (!previous) notFound("regression_dataset_not_found", "Regression dataset not found.");
      if (previous.data.status !== "active") {
        conflict(
          "regression_dataset_archived",
          "Archived regression datasets cannot accept cases.",
        );
      }
      const candidates = input.cases.map((data) =>
        canonicalRecord(DatasetCaseRecord, { data, itemType: "dataset-case" }),
      );
      for (const candidate of candidates) {
        if (candidate.data.datasetId !== previous.data.id) {
          invalidInput("dataset_case_mismatch", "Cases must belong to the target dataset.");
        }
      }
      const existingByContent = await findDatasetCasesByContent(
        previous.data.id,
        candidates.map((candidate) => candidate.data.contentSha256),
      );
      const created: DatasetCaseRecord[] = [];
      const seen = new Set(existingByContent.keys());
      for (const candidate of candidates) {
        if (seen.has(candidate.data.contentSha256)) continue;
        seen.add(candidate.data.contentSha256);
        created.push(candidate);
      }
      const existing = candidates.flatMap((candidate) => {
        const match = existingByContent.get(candidate.data.contentSha256);
        return match ? [match] : [];
      });
      if (created.length === 0) return { created, dataset: previous, existing };
      if (previous.data.caseCount + created.length > MAX_EVALUATION_DATASET_CASES) {
        conflict(
          "regression_dataset_full",
          `Regression datasets support at most ${MAX_EVALUATION_DATASET_CASES} cases.`,
        );
      }
      const dataset = nextRecordVersion(
        previous,
        datasetRecord({
          ...previous.data,
          caseCount: previous.data.caseCount + created.length,
          updatedAt: input.updatedAt,
          version: previous.data.version + 1,
        }),
      );
      const operations: TransactionOperation[] = [
        { kind: "put", previousRecord: previous, record: dataset },
        ...created.flatMap((record) => {
          if (uniqueClaimRequirements(record).length !== 1) {
            invalidInput("invalid_dataset_case", "Dataset cases require a content hash claim.");
          }
          return createClaimedRecordOperations(record, record.data.createdAt);
        }),
      ];
      await commitWithEvent(
        database,
        scope,
        operations,
        {
          aggregateId: dataset.data.id,
          aggregateType: "regression_dataset",
          aggregateVersion: dataset.data.version,
          event,
        },
        "dataset case write",
      );
      return { created, dataset, existing };
    },

    getDatasetCase,

    listDatasetCases: (datasetId, options) =>
      queryScopedPage(database, scope, {
        itemType: "dataset-case",
        options,
        partition: datasetPartition(datasetId),
        prefix: "DATASET-CASE#",
        table: "control",
      }),

    listAllDatasetCases: (datasetId) =>
      queryAllScoped(
        database,
        scope,
        {
          itemType: "dataset-case",
          partition: datasetPartition(datasetId),
          prefix: "DATASET-CASE#",
          table: "control",
        },
        MAX_EVALUATION_DATASET_CASES,
      ),
  };
}
