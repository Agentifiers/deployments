import { Schema } from "effect";
import type { Ulid } from "./ids.ts";
import type { ItemType } from "./records/index.ts";

export class InvalidKeyPartError extends Schema.TaggedErrorClass<InvalidKeyPartError>()(
  "InvalidKeyPartError",
  {
    message: Schema.String,
    value: Schema.String,
  },
) {}

function part(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new InvalidKeyPartError({ message: "DynamoDB key parts must not be empty.", value });
  }
  return encodeURIComponent(normalized);
}

export function key(...parts: readonly string[]) {
  return parts.map(part).join("#");
}

export const UNIQUE_CLAIM_CONDITION = "attribute_not_exists(pk) AND attribute_not_exists(sk)";

export function organizationWriteFenceCondition(observedAt = new Date()) {
  return {
    conditionExpression:
      "attribute_not_exists(pk) OR #fenceData.#fenceLeaseExpiresAt <= :fenceObservedAt",
    expressionAttributeNames: {
      "#fenceData": "data",
      "#fenceLeaseExpiresAt": "leaseExpiresAt",
    },
    expressionAttributeValues: {
      ":fenceObservedAt": observedAt.toISOString(),
    },
  } as const;
}

export function organizationWriteConditionChecks(organizationId: string, controlTable: string) {
  const fenceCondition = organizationWriteFenceCondition();
  return [
    {
      ConditionCheck: {
        ConditionExpression: fenceCondition.conditionExpression,
        ExpressionAttributeNames: fenceCondition.expressionAttributeNames,
        ExpressionAttributeValues: fenceCondition.expressionAttributeValues,
        Key: {
          pk: key("ORG", organizationId),
          sk: key("ERASURE-FENCE", organizationId),
        },
        TableName: controlTable,
      },
    },
    {
      ConditionCheck: {
        ConditionExpression: "attribute_exists(pk)",
        Key: {
          pk: key("ORG", organizationId),
          sk: key("ORG", organizationId),
        },
        TableName: controlTable,
      },
    },
  ];
}

export const Keys = {
  control: {
    memorySearchIndexDropReceipt: (organizationId: Ulid) => ({
      pk: key("ORG", organizationId),
      sk: key("MEMORY-SEARCH-INDEX-DROP-RECEIPT"),
    }),
    operatorFundedSpendExhaustion: (organizationId: Ulid, month: string) => ({
      pk: key("ORG", organizationId),
      sk: key("OPERATOR-FUNDED-SPEND-EXHAUSTION", month),
    }),
    organizationEgressAllowlist: (organizationId: Ulid) => ({
      pk: key("ORG", organizationId),
      sk: key("ORGANIZATION-EGRESS-ALLOWLIST"),
    }),
    organizationOperatorAccess: (organizationId: Ulid, principalId: Ulid) => ({
      pk: key("ORG", organizationId),
      sk: key("ORGANIZATION-OPERATOR-ACCESS", principalId),
    }),
    organizationStanding: (organizationId: Ulid) => ({
      pk: key("ORG", organizationId),
      sk: key("ORGANIZATION-STANDING"),
    }),
    uniqueClaim: (namespace: string, value: string) => ({
      pk: key("UNIQUE", namespace),
      sk: key("VALUE", value),
    }),
  },
  index: {
    environmentResource: (
      environmentId: Ulid,
      itemType: ItemType,
      status: string,
      updatedAt: string,
      resourceId: Ulid,
    ) => ({
      gsi2pk: key("ENV", environmentId),
      gsi2sk: key(itemType.toUpperCase(), status, updatedAt, resourceId),
    }),
    organizationResource: (
      organizationId: Ulid,
      itemType: ItemType,
      status: string,
      updatedAt: string,
      resourceId: Ulid,
    ) => ({
      gsi1pk: key("ORG", organizationId),
      gsi1sk: key(itemType.toUpperCase(), status, updatedAt, resourceId),
    }),
  },
} as const;
