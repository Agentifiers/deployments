import {
  Keys,
  type DynamoDatabaseService,
  type PlatformRecord,
  type TransactionOperation,
} from "@deployments-ai/db";

export const ORGANIZATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const PROJECT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
export const ENVIRONMENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
export const PRINCIPAL_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";

export function storageKey(table: string, key: { readonly pk: string; readonly sk: string }) {
  return `${table}\u0000${key.pk}\u0000${key.sk}`;
}

export function databaseWithRecords(records: Map<string, PlatformRecord>) {
  const principalKey = {
    pk: `PRINCIPAL#${PRINCIPAL_ID}`,
    sk: `PRINCIPAL#${PRINCIPAL_ID}`,
  };
  if (!records.has(storageKey("control", principalKey))) {
    records.set(storageKey("control", principalKey), {
      ...principalKey,
      data: { id: PRINCIPAL_ID, kind: "human", status: "active" },
      itemType: "principal",
    } as unknown as PlatformRecord);
  }
  const database: DynamoDatabaseService = {
    deleteRecord: async (record) => {
      records.delete(storageKey("events", record));
    },
    getRecord: async (table, key) => {
      const record = records.get(storageKey(table, key));
      return record ? structuredClone(record) : undefined;
    },
    putRecord: async (record) => {
      records.set(storageKey("events", record), structuredClone(record));
    },
    queryRecords: async () => ({ items: [] as readonly PlatformRecord[] }),
    transactWrite: async (operations: readonly TransactionOperation[]) => {
      for (const operation of operations) {
        if (operation.kind === "condition-check") continue;
        const key = storageKey(
          operation.record.itemType === "idempotency" ? "events" : "control",
          operation.record,
        );
        if (operation.kind === "delete") {
          records.delete(key);
        } else {
          records.set(key, structuredClone(operation.record));
        }
      }
    },
  };
  return database;
}

export function environmentHierarchyRecords() {
  const environmentKey = { pk: "environment-pk", sk: "environment-sk" };
  const claimKey = Keys.control.uniqueClaim("environment-id", ENVIRONMENT_ID);
  const records = new Map<string, PlatformRecord>();
  records.set(storageKey("control", claimKey), {
    ...claimKey,
    data: {
      namespace: "environment-id",
      ownerId: ENVIRONMENT_ID,
      ownerItemType: "environment",
      ownerPk: environmentKey.pk,
      ownerSk: environmentKey.sk,
      value: ENVIRONMENT_ID,
    },
    itemType: "unique-claim",
  } as unknown as PlatformRecord);
  records.set(storageKey("control", environmentKey), {
    ...environmentKey,
    data: {
      id: ENVIRONMENT_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
    },
    itemType: "environment",
  } as unknown as PlatformRecord);
  const membershipKey = {
    pk: `ORG#${ORGANIZATION_ID}`,
    sk: `ORGANIZATION-MEMBER#${PRINCIPAL_ID}`,
  };
  records.set(storageKey("control", membershipKey), {
    ...membershipKey,
    data: {
      organizationId: ORGANIZATION_ID,
      principalId: PRINCIPAL_ID,
      status: "active",
    },
    itemType: "organization-member",
  } as unknown as PlatformRecord);
  return records;
}
