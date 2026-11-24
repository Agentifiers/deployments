import { createHash } from "node:crypto";
import { key } from "./keys.ts";

interface KeyableRecord {
  readonly data: Readonly<Record<string, unknown>>;
  readonly itemType: string;
}

type Field = (data: Readonly<Record<string, unknown>>, name: string) => string | undefined;
type RequiredField = (record: KeyableRecord, name: string) => string;

interface SecondaryKeys {
  readonly gsi1pk?: string;
  readonly gsi1sk?: string;
  readonly gsi2pk?: string;
  readonly gsi2sk?: string;
}

const targetControlTypes = new Set([
  "memory-index-state",
  "memory-provider-mutation-claim",
  "memory-provider-mutation-gate",
]);

function identityHash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function memorySearchTargetRecordDigest(table: string, pk: string, sk: string) {
  return identityHash(`${table}\u0000${pk}\u0000${sk}`);
}

export function memorySearchIdentityParts(
  record: KeyableRecord,
  field: Field,
  requiredField: RequiredField,
): readonly string[] | undefined {
  switch (record.itemType) {
    case "memory-flush":
      return [requiredField(record, "idempotencyKey")];
    case "memory-index-job":
      return field(record.data, "targetId")
        ? [requiredField(record, "targetId"), requiredField(record, "idempotencyKey")]
        : [requiredField(record, "idempotencyKey")];
    case "memory-directory-entry":
      return [requiredField(record, "memoryId")];
    case "memory-directory-shard":
      return [requiredField(record, "directoryShard")];
    case "memory-index-state":
      return field(record.data, "targetId")
        ? [requiredField(record, "targetId")]
        : [requiredField(record, "memoryId")];
    case "memory-provider-mutation-claim":
      return [
        requiredField(record, "targetId"),
        identityHash(requiredField(record, "messageGroup")),
      ];
    case "memory-provider-mutation-gate":
      return [requiredField(record, "targetId")];
    case "memory-provider-purge-checkpoint":
      return [requiredField(record, "operationId"), requiredField(record, "targetId")];
    case "memory-search-physical-owner":
      return [requiredField(record, "physicalLocationHash")];
    case "memory-search-target-identity":
      return [requiredField(record, "targetId")];
    case "memory-search-target-record":
      return [
        memorySearchTargetRecordDigest(
          requiredField(record, "recordTable"),
          requiredField(record, "recordPk"),
          requiredField(record, "recordSk"),
        ),
      ];
    case "memory-search-generation-live-shard":
      return [requiredField(record, "generationId"), requiredField(record, "liveShard")];
    case "memory-search-generation-live-target":
      return [
        requiredField(record, "generationId"),
        requiredField(record, "liveShard"),
        requiredField(record, "targetId"),
        requiredField(record, "componentId"),
      ];
    case "memory-search-generation-target":
      return [
        requiredField(record, "generationId"),
        requiredField(record, "membershipShard"),
        requiredField(record, "targetDigest"),
      ];
    case "memory-search-generation-target-shard":
      return [requiredField(record, "generationId"), requiredField(record, "membershipShard")];
    case "memory-search-mutation-fence":
    case "memory-search-placement":
      return [requiredField(record, "organizationId")];
    default:
      return undefined;
  }
}

export function memorySearchPrimaryKeys(
  record: KeyableRecord,
  requiredField: RequiredField,
): { readonly pk: string; readonly sk: string } | undefined {
  if (record.itemType === "memory-directory-entry") {
    return {
      pk: key(
        "ORG",
        requiredField(record, "organizationId"),
        "MEMORY-DIRECTORY",
        requiredField(record, "directoryShard"),
      ),
      sk: key("MEMORY", requiredField(record, "memoryId")),
    };
  }
  if (record.itemType === "memory-directory-shard") {
    return {
      pk: key("ORG", requiredField(record, "organizationId"), "MEMORY-DIRECTORY"),
      sk: key("SHARD", requiredField(record, "directoryShard")),
    };
  }
  if (record.itemType === "memory-search-physical-owner") {
    const location = requiredField(record, "physicalLocationHash");
    return {
      pk: key("MEMORY-SEARCH-PHYSICAL-OWNER", location),
      sk: key("MEMORY-SEARCH-PHYSICAL-OWNER", location),
    };
  }
  if (record.itemType === "memory-search-target-identity") {
    const targetId = requiredField(record, "targetId");
    return {
      pk: key("MEMORY-SEARCH-TARGET-IDENTITY", targetId),
      sk: key("MEMORY-SEARCH-TARGET-IDENTITY", targetId),
    };
  }
  if (record.itemType === "memory-search-target-record") {
    return {
      pk: key("MEMORY-SEARCH-TARGET", requiredField(record, "targetId")),
      sk: key(
        "RECORD",
        memorySearchTargetRecordDigest(
          requiredField(record, "recordTable"),
          requiredField(record, "recordPk"),
          requiredField(record, "recordSk"),
        ),
      ),
    };
  }
  if (
    record.itemType === "memory-search-generation-target" ||
    record.itemType === "memory-search-generation-target-shard"
  ) {
    return {
      pk: key(
        "MEMORY-SEARCH-GENERATION",
        requiredField(record, "generationId"),
        "MEMBERSHIP",
        requiredField(record, "membershipShard"),
      ),
      sk:
        record.itemType === "memory-search-generation-target"
          ? key("TARGET", requiredField(record, "targetDigest"))
          : key("SHARD-HEAD"),
    };
  }
  if (
    record.itemType === "memory-search-generation-live-target" ||
    record.itemType === "memory-search-generation-live-shard"
  ) {
    return {
      pk: key(
        "MEMORY-SEARCH-GENERATION",
        requiredField(record, "generationId"),
        "LIVE",
        requiredField(record, "liveShard"),
      ),
      sk:
        record.itemType === "memory-search-generation-live-target"
          ? key("TARGET", requiredField(record, "targetId"), requiredField(record, "componentId"))
          : key("SHARD-HEAD"),
    };
  }
  return undefined;
}

export function memorySearchControlSecondaryKeys(
  record: KeyableRecord,
  identity: readonly string[],
  resourceSort: string,
  field: Field,
  requiredField: RequiredField,
): SecondaryKeys {
  const operationKeys =
    record.itemType === "memory-search-provisioning" && field(record.data, "nextActionAt")
      ? {
          gsi1pk: key("MEMORY-SEARCH-OPERATION", requiredField(record, "operationShard")),
          gsi1sk: key(
            requiredField(record, "nextActionAt"),
            requiredField(record, "actionGeneration").padStart(16, "0"),
            ...identity,
          ),
        }
      : {};
  const targetKeys =
    targetControlTypes.has(record.itemType) && field(record.data, "targetId")
      ? {
          gsi2pk: key("MEMORY-SEARCH-TARGET", requiredField(record, "targetId")),
          gsi2sk: resourceSort,
        }
      : {};
  return { ...operationKeys, ...targetKeys };
}

export function memorySearchExecutionSecondaryKeys(
  record: KeyableRecord,
  identity: readonly string[],
  resourceSort: string,
  status: string,
  field: Field,
  requiredField: RequiredField,
): SecondaryKeys {
  const shadowKeys =
    record.itemType === "memory-shadow-job"
      ? {
          gsi1pk: key("MEMORY-SEARCH-TARGET", requiredField(record, "targetId")),
          gsi1sk: resourceSort,
        }
      : {};
  const targetKeys =
    record.itemType === "memory-index-job" && field(record.data, "targetId")
      ? {
          gsi2pk: key("MEMORY-SEARCH-TARGET", requiredField(record, "targetId")),
          gsi2sk: resourceSort,
        }
      : {};
  return { ...shadowKeys, ...targetKeys };
}
