import { Schema } from "effect";
import type { DynamoDatabaseService } from "../client-types.ts";
import { makeIdGenerator, type Ulid } from "../ids.ts";
import { key } from "../keys.ts";
import { PersistenceError } from "../persistence-types.ts";
import { withCanonicalRecordKeys } from "../records/index.ts";
import { InstallationDeploymentRecord, InstallationRecord } from "../records/system.ts";
import {
  decodeSystemCursor,
  encodeSystemCursor,
  runSystemPersistence,
  systemPageLimit,
  type SystemPage,
  type SystemPageOptions,
} from "./support.ts";

type InstallationRecordValue = typeof InstallationRecord.Type;
type InstallationDeploymentRecordValue = typeof InstallationDeploymentRecord.Type;
export type Installation = InstallationRecordValue["data"];
export type InstallationDeployment = InstallationDeploymentRecordValue["data"];

/** What a deploy-tool run reports; the repository stamps identity and time. */
export type InstallationDeploymentInput = Omit<
  InstallationDeployment,
  "createdAt" | "deployedAt" | "id"
>;

export interface RecordedInstallationDeployment {
  readonly deployment: InstallationDeployment;
  readonly installation: Installation;
}

export interface InstallationRepository {
  /** The install's current release, or undefined before the first recorded deployment. */
  readonly current: () => Promise<Installation | undefined>;
  /** Deployment history, newest first. */
  readonly listDeployments: (
    options?: SystemPageOptions,
  ) => Promise<SystemPage<InstallationDeployment>>;
  /**
   * Appends a create-only history entry and replaces the installation singleton (version + 1)
   * in one transaction.
   */
  readonly recordDeployment: (
    input: InstallationDeploymentInput,
  ) => Promise<RecordedInstallationDeployment>;
}

export interface InstallationRepositoryOptions {
  readonly generateId?: () => Promise<Ulid>;
  readonly now?: () => Date;
}

const INSTALLATION_KEY = { pk: key("GLOBAL", "installation"), sk: key("INSTALLATION", "current") };
const DEPLOYMENT_PARTITION = key("GLOBAL", "installation-deployment");
const DEPLOYMENT_PREFIX = `${key("INSTALLATION-DEPLOYMENT")}#`;

function decodeRecord<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch (cause) {
    throw new PersistenceError(
      "invalid-input",
      "invalid_installation",
      cause instanceof Error ? cause.message : "The installation record is invalid.",
    );
  }
}

export function makeInstallationRepository(
  database: DynamoDatabaseService,
  options: InstallationRepositoryOptions = {},
): InstallationRepository {
  const now = options.now ?? (() => new Date());
  const ids = makeIdGenerator();
  const generateId = options.generateId ?? (async () => ids.generate());

  async function currentRecord() {
    const record = await runSystemPersistence(
      "read the installation",
      database.getRecord("control", INSTALLATION_KEY, true),
    );
    return record?.itemType === "installation" ? record : undefined;
  }

  return {
    async current() {
      return (await currentRecord())?.data;
    },
    async listDeployments(page = {}) {
      const exclusiveStartKey = decodeSystemCursor(page.cursor, {
        partition: DEPLOYMENT_PARTITION,
        partitionField: "pk",
      });
      const result = await runSystemPersistence(
        "list installation deployments",
        database.queryRecords("control", {
          ConsistentRead: true,
          ExpressionAttributeValues: { ":pk": DEPLOYMENT_PARTITION, ":prefix": DEPLOYMENT_PREFIX },
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
          Limit: systemPageLimit(page.limit),
          ScanIndexForward: false,
          ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
        }),
      );
      return {
        items: result.items.flatMap((record) =>
          record.itemType === "installation-deployment" ? [record.data] : [],
        ),
        ...(result.lastEvaluatedKey
          ? { nextCursor: encodeSystemCursor(result.lastEvaluatedKey) }
          : {}),
      };
    },
    async recordDeployment(input) {
      const timestamp = now().toISOString();
      const id = await generateId();
      const previous = await currentRecord();
      const deployment: InstallationDeploymentRecordValue = decodeRecord(
        InstallationDeploymentRecord,
        withCanonicalRecordKeys({
          data: { ...input, createdAt: timestamp, deployedAt: timestamp, id },
          itemType: "installation-deployment" as const,
        }),
      );
      const installation: InstallationRecordValue = decodeRecord(
        InstallationRecord,
        withCanonicalRecordKeys({
          data: {
            ...input,
            createdAt: previous?.data.createdAt ?? timestamp,
            deployedAt: timestamp,
            deploymentId: id,
            id: "current" as const,
            updatedAt: timestamp,
            version: previous ? previous.data.version + 1 : 1,
          },
          itemType: "installation" as const,
        }),
      );
      await runSystemPersistence(
        "record the installation deployment",
        database.transactWrite([
          { kind: "put", record: deployment },
          { kind: "put", record: installation, ...(previous ? { previousRecord: previous } : {}) },
        ]),
      );
      return { deployment: deployment.data, installation: installation.data };
    },
  };
}
