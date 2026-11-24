import { CanonicalKeyError, type KeyableRecord } from "./record-key-fields.ts";
import { identityParts } from "./record-key-identity.ts";
import { primaryKeys } from "./record-key-primary.ts";
import { secondaryKeys } from "./record-key-secondary.ts";

export { CanonicalKeyError, type KeyableRecord } from "./record-key-fields.ts";
export {
  EVENT_DELIVERY_SHARD_COUNT,
  EXECUTION_QUEUE_SHARD_COUNT,
  IDENTITY_EMAIL_DISPATCH_SHARD_COUNT,
  MONITOR_SWEEP_SHARD_COUNT,
} from "./record-key-secondary.ts";
export type LogicalTableName =
  | "control"
  | "events"
  | "execution"
  | "identity"
  | "identity-email-outbox"
  | "usage";

export interface CanonicalRecordKeys {
  readonly gsi1pk?: string;
  readonly gsi1sk?: string;
  readonly gsi2pk?: string;
  readonly gsi2sk?: string;
  readonly pk: string;
  readonly sk: string;
}

const keyByteLimits = {
  gsi1pk: 2_048,
  gsi1sk: 1_024,
  gsi2pk: 2_048,
  gsi2sk: 1_024,
  pk: 2_048,
  sk: 1_024,
} as const;

export function canonicalRecordKeys(
  record: KeyableRecord,
  table: LogicalTableName,
): CanonicalRecordKeys {
  const identity = identityParts(record);
  const keys = {
    ...primaryKeys(record, identity),
    ...secondaryKeys(record, table, identity),
  };

  for (const [fieldName, maximumBytes] of Object.entries(keyByteLimits)) {
    const value = keys[fieldName as keyof CanonicalRecordKeys];
    if (value !== undefined && new TextEncoder().encode(value).byteLength > maximumBytes) {
      throw new CanonicalKeyError({
        field: fieldName,
        itemType: record.itemType,
        message: `Record ${record.itemType} produces ${fieldName} larger than ${maximumBytes} bytes.`,
      });
    }
  }

  return keys;
}
