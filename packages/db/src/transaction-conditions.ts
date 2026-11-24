import { Effect, Equal } from "effect";
import { createHash } from "node:crypto";
import type {
  CanonicalPutRecords,
  SemanticEventRecord,
  TransactionConditionCheck,
  TransactionDelete,
  TransactionOperation,
  TransactionPut,
} from "./client-types.ts";
import { DatabaseError } from "./client-types.ts";
import { directoryImmutableFields } from "./directory/record-rules.ts";
import { key, UNIQUE_CLAIM_CONDITION } from "./keys.ts";
import type { PersistenceInvocation } from "./persistence-types.ts";
import {
  decodePlatformRecord,
  type PlatformRecord,
  type RecordDecodeError,
} from "./records/index.ts";
import { semanticAggregatesOf } from "./semantic-aggregate-identity.ts";
import { type UniqueClaimRequirement } from "./unique-claims.ts";
export const RUN_LOCATOR_UPSERT_CONDITION =
  "attribute_not_exists(pk) OR (#locatorItemType = :locatorItemType AND #locatorData.#locatorRunPk = :locatorRunPk AND #locatorData.#locatorRunSk = :locatorRunSk)";
const EXPIRED_IDEMPOTENCY_REPLACEMENT_CONDITION =
  "(attribute_not_exists(pk) AND attribute_not_exists(sk)) OR (#idempotencyItemType = :idempotencyItemType AND #idempotencyData.#idempotencyExpiresAt <= :idempotencyNow)";
const EXPIRED_UNIQUE_CLAIM_ACQUISITION_CONDITION =
  "(attribute_not_exists(pk) AND attribute_not_exists(sk)) OR (#uniqueClaimItemType = :uniqueClaimItemType AND #uniqueClaimData.#uniqueClaimExpiresAt <= :uniqueClaimNow)";

export function expiredIdempotencyReplacementCondition(record: PlatformRecord) {
  if (record.itemType !== "idempotency") {
    throw new TypeError("Expired replacement is restricted to idempotency records.");
  }
  return {
    conditionExpression: EXPIRED_IDEMPOTENCY_REPLACEMENT_CONDITION,
    expressionAttributeNames: {
      "#idempotencyData": "data",
      "#idempotencyExpiresAt": "expiresAt",
      "#idempotencyItemType": "itemType",
    },
    expressionAttributeValues: {
      ":idempotencyItemType": "idempotency",
      ":idempotencyNow": record.data.createdAt,
    },
  } as const;
}

export function isExpiredIdempotencyReplacement(operation: TransactionPut) {
  if (!operation.replaceExpired || operation.record.itemType !== "idempotency") return false;
  const expected = expiredIdempotencyReplacementCondition(operation.record);
  return (
    operation.conditionExpression === expected.conditionExpression &&
    Equal.equals(operation.expressionAttributeNames, expected.expressionAttributeNames) &&
    Equal.equals(operation.expressionAttributeValues, expected.expressionAttributeValues)
  );
}

export function expiredUniqueClaimAcquisitionCondition(observedAt: string) {
  return {
    conditionExpression: EXPIRED_UNIQUE_CLAIM_ACQUISITION_CONDITION,
    expressionAttributeNames: {
      "#uniqueClaimData": "data",
      "#uniqueClaimExpiresAt": "expiresAt",
      "#uniqueClaimItemType": "itemType",
    },
    expressionAttributeValues: {
      ":uniqueClaimItemType": "unique-claim",
      ":uniqueClaimNow": observedAt,
    },
  } as const;
}

function isExpiredUniqueClaimAcquisition(operation: TransactionPut) {
  if (!operation.replaceExpired || operation.record.itemType !== "unique-claim") return false;
  const observedAt = operation.expressionAttributeValues?.[":uniqueClaimNow"];
  if (
    typeof observedAt !== "string" ||
    !Number.isFinite(Date.parse(observedAt)) ||
    new Date(Date.parse(observedAt)).toISOString() !== observedAt ||
    operation.record.data.expiresAt === undefined
  ) {
    return false;
  }
  const expected = expiredUniqueClaimAcquisitionCondition(observedAt);
  return (
    operation.conditionExpression === expected.conditionExpression &&
    Equal.equals(operation.expressionAttributeNames, expected.expressionAttributeNames) &&
    Equal.equals(operation.expressionAttributeValues, expected.expressionAttributeValues)
  );
}

function errorName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Readonly<Record<string, unknown>>;
  const name = candidate.name ?? candidate.Code ?? candidate.code ?? candidate.__type;
  return typeof name === "string" ? name : undefined;
}

function errorCause(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Readonly<Record<string, unknown>>).cause;
}

export function isDatabaseWriteConflict(value: unknown): boolean {
  let current: unknown = value;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof DatabaseError && current.reason) {
      return current.reason === "conflict";
    }
    const name = errorName(current);
    if (name?.includes("ConditionalCheckFailed") || name?.includes("TransactionConflict")) {
      return true;
    }
    if (name?.includes("TransactionCanceled")) {
      const candidate = current as Readonly<Record<string, unknown>>;
      const reasons = candidate.CancellationReasons ?? candidate.cancellationReasons;
      if (
        Array.isArray(reasons) &&
        reasons.some((reason) => {
          const code = errorName(reason);
          return code?.includes("ConditionalCheckFailed") || code?.includes("TransactionConflict");
        })
      ) {
        return true;
      }
    }
    current = errorCause(current);
  }
  return false;
}

const TRANSIENT_CANCELLATION_CODES: Record<string, true> = {
  None: true,
  ProvisionedThroughputExceeded: true,
  ThrottlingError: true,
  TransactionConflict: true,
};

/** A conflict or a throttle cancelled the transaction, and no condition failed, so resending it can commit. */
export function isTransientTransactionCancellation(cause: unknown) {
  const name = errorName(cause);
  if (name === "TransactionConflictException") return true;
  if (name !== "TransactionCanceledException") return false;
  const candidate = cause as Readonly<Record<string, unknown>>;
  const reasons = candidate.CancellationReasons ?? candidate.cancellationReasons;
  if (!Array.isArray(reasons) || reasons.length === 0) return false;
  const codes = reasons.map(errorName);
  return (
    codes.some((code) => code !== "None") &&
    codes.every((code) => code !== undefined && TRANSIENT_CANCELLATION_CODES[code] === true)
  );
}

const THROTTLING_ERROR_NAMES = [
  "Throttling",
  "ProvisionedThroughputExceeded",
  "RequestLimitExceeded",
];

/**
 * True when contention, not a failed condition, made DynamoDB refuse the request: a transaction
 * conflict or a throttle that outlasted the retries. Sending the request again later can succeed.
 */
export function isDatabaseContention(value: unknown): boolean {
  let current: unknown = value;
  const seen = new Set<unknown>();
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const name = errorName(current);
    if (
      isTransientTransactionCancellation(current) ||
      THROTTLING_ERROR_NAMES.some((throttling) => name?.includes(throttling))
    ) {
      return true;
    }
    current = errorCause(current);
  }
  return false;
}

export function makeDatabaseTransactionToken(parts: readonly string[]) {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 36);
}

function canonicalRequestParameters(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalRequestParameters);
  if (value instanceof Uint8Array) return { binary: Buffer.from(value).toString("base64") };
  if (value instanceof Set) {
    return { set: [...value].map((entry) => JSON.stringify(entry)).toSorted() };
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, entry]) => [name, canonicalRequestParameters(entry)]),
  );
}

/**
 * DynamoDB rejects a ClientRequestToken reused with different parameters inside its
 * idempotency window, including after the first request was cancelled. Binding the token to the
 * exact TransactItems keeps identical retries idempotent and gives a changed retry (fresh
 * timestamps, versions, or fence observations) its own token so its conditions decide the outcome.
 */
export function makeTransactWriteRequestToken(
  parts: readonly string[],
  transactItems: readonly unknown[],
) {
  return makeDatabaseTransactionToken([
    ...parts,
    JSON.stringify(canonicalRequestParameters(transactItems)),
  ]);
}

function identityScope(values: readonly string[] | "*" | undefined) {
  return values === "*" ? values : JSON.stringify([...(values ?? [])].toSorted());
}

export function makePersistenceTransactionToken(
  invocation: PersistenceInvocation,
  operation: string,
  attempt = 0,
) {
  if (!invocation.idempotencyKey) return undefined;
  return makeDatabaseTransactionToken([
    invocation.identity.principalId,
    identityScope(invocation.identity.organizationIds),
    identityScope(invocation.identity.projectIds),
    invocation.scope.organizationId ?? "",
    invocation.scope.projectId ?? "",
    invocation.scope.environmentId ?? "",
    operation,
    invocation.idempotencyKey,
    String(attempt),
  ]);
}

export function databaseFailure(operation: string, table: string, cause: unknown) {
  return new DatabaseError({
    cause,
    message: `DynamoDB ${operation} failed for table ${table}.`,
    operation,
    reason: isDatabaseWriteConflict(cause) ? "conflict" : "unknown",
    table,
  });
}

export function canonicalizeTransactionOperation(
  operation: TransactionOperation,
): Effect.Effect<TransactionOperation, DatabaseError | RecordDecodeError> {
  if (operation.kind === "condition-check") {
    return Effect.succeed(operation);
  }

  if (operation.kind === "delete") {
    return decodePlatformRecord(operation.record).pipe(
      Effect.map(
        (record) =>
          ({
            ...operation,
            record,
          }) satisfies TransactionOperation,
      ),
    );
  }

  return decodePlatformRecord(operation.record).pipe(
    Effect.flatMap((record) =>
      operation.previousRecord
        ? decodePlatformRecord(operation.previousRecord).pipe(
            Effect.map((previousRecord): CanonicalPutRecords => ({ record, previousRecord })),
          )
        : Effect.succeed<CanonicalPutRecords>({ record }),
    ),
    Effect.flatMap(({ previousRecord, record }) => {
      if (
        record.itemType === "unique-claim" &&
        operation.conditionExpression !== UNIQUE_CLAIM_CONDITION &&
        !isExpiredUniqueClaimAcquisition({ ...operation, record })
      ) {
        return Effect.fail(
          databaseFailure(
            "transact-write",
            "control",
            "Unique claims require a canonical acquisition condition.",
          ),
        );
      }

      return Effect.succeed({
        ...operation,
        ...(previousRecord ? { previousRecord } : {}),
        record,
      } satisfies TransactionOperation);
    }),
  );
}

export function recordId(record: PlatformRecord) {
  const id = (record.data as Readonly<Record<string, unknown>>).id;
  return typeof id === "string" ? id : undefined;
}

export function recordVersion(record: PlatformRecord) {
  const version = (record.data as Readonly<Record<string, unknown>>).version;
  return typeof version === "number" && Number.isInteger(version) && version >= 0
    ? version
    : undefined;
}

/**
 * The condition that a semantic event's predecessor exists, or `undefined` when its order is
 * already proven. An event appended with a versioned put or delete of the stored record that
 * holds its aggregate (see `semanticAggregatesOf`) is ordered by that record's version condition,
 * so it does not depend on the previous event, which retention may have deleted. Aggregates number
 * their events by their own convention (some start at record version 0), so the record's version
 * is not compared with the event's.
 */
export function semanticEventPredecessorCheck(
  record: SemanticEventRecord,
  operations: readonly TransactionOperation[],
): TransactionConditionCheck | undefined {
  if (record.data.aggregateVersion === 1) return undefined;
  const { aggregateId, aggregateType } = record.data;
  const writesAggregateRecord = operations.some((operation) => {
    const stored =
      operation.kind === "put"
        ? operation.previousRecord
        : operation.kind === "delete" && !operation.allowMissing
          ? operation.record
          : undefined;
    return (
      stored !== undefined &&
      recordVersion(stored) !== undefined &&
      semanticAggregatesOf(stored).some(
        (aggregate) =>
          aggregate.aggregateType === aggregateType && aggregate.aggregateId === aggregateId,
      )
    );
  });
  if (writesAggregateRecord) return undefined;
  const previousVersion = record.data.aggregateVersion - 1;

  return {
    conditionExpression:
      "#itemType = :itemType AND #data.#aggregateType = :aggregateType AND #data.#aggregateId = :aggregateId AND #data.#aggregateVersion = :aggregateVersion",
    expressionAttributeNames: {
      "#aggregateId": "aggregateId",
      "#aggregateType": "aggregateType",
      "#aggregateVersion": "aggregateVersion",
      "#data": "data",
      "#itemType": "itemType",
    },
    expressionAttributeValues: {
      ":aggregateId": record.data.aggregateId,
      ":aggregateType": record.data.aggregateType,
      ":aggregateVersion": previousVersion,
      ":itemType": "semantic-event",
    },
    key: {
      pk: record.pk,
      sk: key("SEMANTIC-EVENT", String(previousVersion).padStart(16, "0")),
    },
    kind: "condition-check",
    table: "events",
  };
}

const commonImmutableIdentityFields = [
  "id",
  "organizationId",
  "projectId",
  "environmentId",
  "workspaceId",
] as const;

const immutableIdentityFieldsByItemType: Readonly<Record<string, readonly string[]>> = {
  "agent-definition-release-index": ["agentDefinitionId", "createdAt"],
  "agent-release": [
    "agentDefinitionId",
    "artifact",
    "contentHash",
    "createdAt",
    "createdByPrincipalId",
    "manifest",
    "releaseNumber",
  ],
  "agent-release-control": ["agentDefinitionId", "agentReleaseId", "createdAt", "releaseNumber"],
  "api-credential": ["serviceAccountId"],
  "app-domain": ["appId", "appSlot", "attachedBy", "createdAt", "hostname", "token"],
  "approval-action-token": ["approvalId", "channel", "createdAt", "expiresAt", "tokenHash"],
  artifact: ["owner"],
  "evaluation-case-run": [
    "caseKey",
    "createdAt",
    "datasetCaseId",
    "evaluationRunId",
    "sourceTraceId",
  ],
  "evaluation-run": ["createdAt", "createdByPrincipalId", "datasetId", "idempotencyKey", "kind"],
  "email-tenant": ["createdAt", "region", "providerName", "configurationSetName"],
  "email-domain": ["createdAt", "tenantId", "domain", "mailFromDomain"],
  "regression-dataset": ["createdAt", "createdByPrincipalId", "name"],
  "release-comparison": ["createdAt", "createdByPrincipalId", "datasetId", "idempotencyKey"],
  "score-definition": ["createdAt", "createdByPrincipalId", "name", "type"],
  "score-definition-revision": [
    "createdAt",
    "evaluatorVersionHash",
    "revision",
    "scoreDefinitionId",
  ],
  "score-result": [
    "createdAt",
    "evaluatorVersionHash",
    "revision",
    "scoreDefinitionId",
    "scoreType",
    "traceId",
  ],
  "model-invocation": ["attemptId", "invocationId", "parentSpanId", "runId", "spanId", "traceId"],
  run: [
    "captureMode",
    "parentSpanId",
    "redactionPolicyVersion",
    "replayedFromRunId",
    "replayedFromTraceId",
    "schemaVersion",
    "spanId",
    "traceId",
  ],
  trace: [
    "captureMode",
    "redactionPolicyVersion",
    "rootRunId",
    "rootSpanId",
    "schemaVersion",
    "sessionId",
    "traceId",
  ],
  idempotency: ["commandHash"],
  "mcp-session": ["connectionId", "createdAt", "expiresAt", "mcpServerId"],
  "oauth-authorization-attempt": [
    "createdAt",
    "expiresAt",
    "oauthClientId",
    "oauthClientRegistration",
    "oauthIssParameterSupported",
    "oauthIssuer",
    "operatorAccessGrantId",
    "principalId",
    "providerApplicationId",
    "providerKey",
    "requestedResource",
    "requestedScopes",
    "returnTo",
    "stateHash",
  ],
  "oauth-refresh-claim": ["connectionId", "credentialGeneration"],
  "principal-identity": ["principalId"],
  "provider-mutation-claim": [
    "claimAttemptId",
    "immutableIdentityHash",
    "connectionId",
    "operation",
    "runId",
    "toolCallId",
  ],
  "sandbox-workspace": ["createdAt", "executionTargetId", "executionTargetKind", "threadId"],
  "semantic-event": ["eventId", "aggregateType", "aggregateId", "aggregateVersion"],
  thread: ["endUserKey"],
  "web-bff-authorization-transaction": [
    "clientId",
    "createdAt",
    "expiresAt",
    "nonceHash",
    "redirectUri",
    "stateHash",
    "transactionTokenHash",
  ],
  "web-bff-session": [
    "clientId",
    "cookieTokenHash",
    "createdAt",
    "expiresAt",
    "principalId",
    "sessionEpoch",
  ],
  "workspace-connection-authorization": [
    "authorizationVersion",
    "connectionId",
    "externalAccountId",
    "externalResourceConstraints",
    "providerKey",
    "purpose",
    "resourceScopeHash",
    "scopes",
  ],
};

function immutableIdentityFields(record: PlatformRecord) {
  return [
    ...commonImmutableIdentityFields,
    ...(immutableIdentityFieldsByItemType[record.itemType] ??
      directoryImmutableFields(record.itemType) ??
      []),
  ];
}

export function hasSameImmutableIdentity(
  previousRecord: PlatformRecord,
  replacementRecord: PlatformRecord,
) {
  const previousData = previousRecord.data as Readonly<Record<string, unknown>>;
  const replacementData = replacementRecord.data as Readonly<Record<string, unknown>>;
  return immutableIdentityFields(previousRecord).every((field) =>
    Equal.equals(previousData[field], replacementData[field]),
  );
}

function reserveExpressionToken(prefix: string, usedTokens: Set<string>) {
  let token = prefix;
  let suffix = 2;
  while (usedTokens.has(token)) {
    token = `${prefix}${suffix}`;
    suffix += 1;
  }
  usedTokens.add(token);
  return token;
}

function appendCondition<Operation extends TransactionOperation>(
  operation: Operation,
  conditionExpression: string,
  expressionAttributeNames: Readonly<Record<string, string>>,
  expressionAttributeValues: Readonly<Record<string, unknown>>,
): Operation {
  return {
    ...operation,
    conditionExpression: operation.conditionExpression
      ? `(${operation.conditionExpression}) AND (${conditionExpression})`
      : conditionExpression,
    expressionAttributeNames: {
      ...operation.expressionAttributeNames,
      ...expressionAttributeNames,
    },
    expressionAttributeValues: {
      ...operation.expressionAttributeValues,
      ...expressionAttributeValues,
    },
  };
}

export function withCreateOnlyCondition(operation: TransactionPut) {
  return {
    ...operation,
    conditionExpression: operation.conditionExpression
      ? `(${operation.conditionExpression}) AND (${UNIQUE_CLAIM_CONDITION})`
      : UNIQUE_CLAIM_CONDITION,
  } satisfies TransactionPut;
}

export function withClaimOwnerCondition<
  Operation extends TransactionDelete | TransactionConditionCheck,
>(operation: Operation, claim: UniqueClaimRequirement): Operation {
  const nameTokens = new Set(Object.keys(operation.expressionAttributeNames ?? {}));
  const valueTokens = new Set(Object.keys(operation.expressionAttributeValues ?? {}));
  const dataName = reserveExpressionToken("#dbClaimData", nameTokens);
  const itemTypeName = reserveExpressionToken("#dbClaimItemType", nameTokens);
  const ownerIdName = reserveExpressionToken("#dbClaimOwnerId", nameTokens);
  const ownerItemTypeName = reserveExpressionToken("#dbClaimOwnerItemType", nameTokens);
  const expiresAtName = reserveExpressionToken("#dbClaimExpiresAt", nameTokens);
  const ownerPkName = reserveExpressionToken("#dbClaimOwnerPk", nameTokens);
  const ownerSkName = reserveExpressionToken("#dbClaimOwnerSk", nameTokens);
  const ownerTableName = reserveExpressionToken("#dbClaimOwnerTable", nameTokens);
  const claimItemTypeValue = reserveExpressionToken(":dbUniqueClaim", valueTokens);
  const ownerIdValue = reserveExpressionToken(":dbClaimOwnerId", valueTokens);
  const ownerItemTypeValue = reserveExpressionToken(":dbClaimOwnerItemType", valueTokens);
  const expiresAtValue = reserveExpressionToken(":dbClaimExpiresAt", valueTokens);
  const ownerPkValue = reserveExpressionToken(":dbClaimOwnerPk", valueTokens);
  const ownerSkValue = reserveExpressionToken(":dbClaimOwnerSk", valueTokens);
  const ownerTableValue = reserveExpressionToken(":dbClaimOwnerTable", valueTokens);

  return appendCondition(
    operation,
    `${itemTypeName} = ${claimItemTypeValue} AND ${dataName}.${ownerIdName} = ${ownerIdValue} AND ${dataName}.${ownerItemTypeName} = ${ownerItemTypeValue} AND ${dataName}.${ownerPkName} = ${ownerPkValue} AND ${dataName}.${ownerSkName} = ${ownerSkValue} AND ${dataName}.${ownerTableName} = ${ownerTableValue} AND ${
      claim.expiresAt === undefined
        ? `attribute_not_exists(${dataName}.${expiresAtName})`
        : `${dataName}.${expiresAtName} = ${expiresAtValue}`
    }`,
    {
      [dataName]: "data",
      [expiresAtName]: "expiresAt",
      [itemTypeName]: "itemType",
      [ownerIdName]: "ownerId",
      [ownerItemTypeName]: "ownerItemType",
      [ownerPkName]: "ownerPk",
      [ownerSkName]: "ownerSk",
      [ownerTableName]: "ownerTable",
    },
    {
      [claimItemTypeValue]: "unique-claim",
      ...(claim.expiresAt === undefined ? {} : { [expiresAtValue]: claim.expiresAt }),
      [ownerIdValue]: claim.ownerId,
      [ownerItemTypeValue]: claim.ownerItemType,
      [ownerPkValue]: claim.ownerPk,
      [ownerSkValue]: claim.ownerSk,
      [ownerTableValue]: claim.ownerTable,
    },
  );
}

export function withRecordVersionCondition<Operation extends TransactionPut | TransactionDelete>(
  operation: Operation,
  previousVersion: number,
) {
  const nameTokens = new Set(Object.keys(operation.expressionAttributeNames ?? {}));
  const valueTokens = new Set(Object.keys(operation.expressionAttributeValues ?? {}));
  const dataName = reserveExpressionToken("#dbResourceData", nameTokens);
  const versionName = reserveExpressionToken("#dbResourceVersion", nameTokens);
  const previousVersionValue = reserveExpressionToken(":dbPreviousVersion", valueTokens);

  return appendCondition(
    operation,
    `${dataName}.${versionName} = ${previousVersionValue}`,
    { [dataName]: "data", [versionName]: "version" },
    { [previousVersionValue]: previousVersion },
  );
}

export function withStoredDataFieldsCondition<Operation extends TransactionPut | TransactionDelete>(
  operation: Operation,
  attributes: Readonly<Record<string, unknown>>,
) {
  if (Object.keys(attributes).length === 0) return operation;

  const nameTokens = new Set(Object.keys(operation.expressionAttributeNames ?? {}));
  const valueTokens = new Set(Object.keys(operation.expressionAttributeValues ?? {}));
  const dataName = reserveExpressionToken("#dbPreviousData", nameTokens);
  const expressionAttributeNames: Record<string, string> = { [dataName]: "data" };
  const expressionAttributeValues: Record<string, unknown> = {};
  const comparisons: string[] = [];

  for (const [field, value] of Object.entries(attributes)) {
    const suffix = field.charAt(0).toUpperCase() + field.slice(1);
    const fieldName = reserveExpressionToken(`#dbPrevious${suffix}`, nameTokens);
    expressionAttributeNames[fieldName] = field;
    if (value === undefined) {
      comparisons.push(`attribute_not_exists(${dataName}.${fieldName})`);
    } else {
      const fieldValue = reserveExpressionToken(`:dbPrevious${suffix}`, valueTokens);
      expressionAttributeValues[fieldValue] = value;
      comparisons.push(`${dataName}.${fieldName} = ${fieldValue}`);
    }
  }

  return appendCondition(
    operation,
    comparisons.join(" AND "),
    expressionAttributeNames,
    expressionAttributeValues,
  );
}

function immutableIdentityAttributes(
  record: PlatformRecord,
  omittedFields: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  const data = record.data as Readonly<Record<string, unknown>>;
  const omitted = new Set(omittedFields);
  return Object.fromEntries(
    immutableIdentityFields(record)
      .filter((field) => !omitted.has(field))
      .map((field) => [field, data[field]]),
  );
}

export function withStoredImmutableIdentityCondition<
  Operation extends TransactionPut | TransactionDelete,
>(operation: Operation, record: PlatformRecord, omittedFields: readonly string[] = []) {
  const conditioned = withStoredDataFieldsCondition(
    operation,
    immutableIdentityAttributes(record, omittedFields),
  );
  const nameTokens = new Set(Object.keys(conditioned.expressionAttributeNames ?? {}));
  const valueTokens = new Set(Object.keys(conditioned.expressionAttributeValues ?? {}));
  const itemTypeName = reserveExpressionToken("#dbImmutableItemType", nameTokens);
  const itemTypeValue = reserveExpressionToken(":dbImmutableItemType", valueTokens);

  return appendCondition(
    conditioned,
    `${itemTypeName} = ${itemTypeValue}`,
    { [itemTypeName]: "itemType" },
    { [itemTypeValue]: record.itemType },
  );
}

export function claimMatches(
  claim: {
    readonly expiresAt?: string | undefined;
    readonly namespace: string;
    readonly ownerId: string;
    readonly ownerItemType: string;
    readonly ownerPk: string;
    readonly ownerSk: string;
    readonly ownerTable: string;
    readonly value: string;
  },
  requirement: UniqueClaimRequirement,
) {
  return (
    claim.namespace === requirement.namespace &&
    claim.expiresAt === requirement.expiresAt &&
    claim.ownerId === requirement.ownerId &&
    claim.ownerItemType === requirement.ownerItemType &&
    claim.ownerPk === requirement.ownerPk &&
    claim.ownerSk === requirement.ownerSk &&
    claim.ownerTable === requirement.ownerTable &&
    claim.value === requirement.value
  );
}
