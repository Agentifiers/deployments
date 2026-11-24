import { Effect } from "effect";
import type {
  SemanticEventRecord,
  TransactionConditionCheck,
  TransactionDelete,
  TransactionOperation,
  TransactionPut,
  UniqueClaimDelete,
  UniqueClaimPut,
} from "./client-types.ts";
import { DatabaseError } from "./client-types.ts";
import { key, Keys, organizationWriteFenceCondition, UNIQUE_CLAIM_CONDITION } from "./keys.ts";
import { isCanonicalMemorySearchTargetDirectoryPut } from "./memory-search-target-directory.ts";
import { isCanonicalGovernanceTenantDirectoryPut } from "./governance-tenant-directory.ts";
import { tableForItemType } from "./records/index.ts";
import {
  claimMatches,
  databaseFailure,
  hasSameImmutableIdentity,
  isExpiredIdempotencyReplacement,
  recordId,
  recordVersion,
  RUN_LOCATOR_UPSERT_CONDITION,
  semanticEventPredecessorCheck,
  withClaimOwnerCondition,
  withCreateOnlyCondition,
  withRecordVersionCondition,
  withStoredDataFieldsCondition,
  withStoredImmutableIdentityCondition,
} from "./transaction-conditions.ts";
import {
  uniqueClaimRequirements,
  uniqueOwnerAttributes,
  type UniqueClaimRequirement,
} from "./unique-claims.ts";
import { identityTransactionInvariantViolation } from "./transaction-invariants-identity.ts";
import { withThreadErasureFences } from "./thread-erasure/fences.ts";
import { withInboxMailErasureFences } from "./thread-erasure/mail-fences.ts";
import {
  isOrganizationGateLane,
  organizationGateLane,
  organizationGateLaneCheck,
} from "./organization-gate/lanes.ts";
export * from "./transaction-conditions.ts";

/**
 * Adds the organization-wide checks every tenant write needs: the organization exists and no
 * governance fence holds it. A transaction that leaves the organization's gate state alone checks
 * them, with every `organizationGateCheck` requirement, on one of the organization's gate lanes.
 * A transaction that rewrites the lanes, or checks them absent, checks the source records themselves.
 */
export function withOrganizationErasureFences(
  operations: readonly TransactionOperation[],
  erasureOwner?: { readonly operationId: string; readonly organizationId: string },
): Effect.Effect<readonly TransactionOperation[], DatabaseError> {
  let augmentedOperations = [...withInboxMailErasureFences(withThreadErasureFences(operations))];
  const gateChecks = augmentedOperations.flatMap((operation) =>
    operation.kind === "condition-check" && operation.organizationGate
      ? [{ check: operation, gate: operation.organizationGate }]
      : [],
  );
  const organizationIds = new Set([
    ...gateChecks.map(({ gate }) => gate.organizationId),
    ...operations
      .filter(
        (operation): operation is TransactionPut | TransactionDelete =>
          operation.kind === "put" || operation.kind === "delete",
      )
      .map((operation) => {
        // The identity email outbox is not tenant-governed. Invitation deliveries name their
        // organization, but the worker must still settle them (sent/discarded) after erasure.
        if (tableForItemType(operation.record.itemType) === "identity-email-outbox") {
          return undefined;
        }
        const data = operation.record.data as Readonly<Record<string, unknown>>;
        if (typeof data.organizationId === "string") return data.organizationId;
        if (operation.record.itemType === "organization") {
          return typeof data.id === "string" ? data.id : undefined;
        }
        return undefined;
      })
      .filter((organizationId): organizationId is string => typeof organizationId === "string"),
  ]);
  const lane = organizationGateLane(operations);

  for (const organizationId of organizationIds) {
    const fenceKey = {
      pk: key("ORG", organizationId),
      sk: key("ERASURE-FENCE", organizationId),
    };
    const organizationKey = {
      pk: key("ORG", organizationId),
      sk: key("ORG", organizationId),
    };
    const existingFenceCheck = augmentedOperations.find(
      (operation) =>
        operation.kind === "condition-check" &&
        operation.table === "control" &&
        operation.key.pk === fenceKey.pk &&
        operation.key.sk === fenceKey.sk,
    );
    const fenceCondition =
      erasureOwner?.organizationId === organizationId
        ? {
            conditionExpression:
              "#fenceData.#fenceOperationId = :fenceOperationId AND #fenceItemType = :fenceItemType",
            expressionAttributeNames: {
              "#fenceData": "data",
              "#fenceItemType": "itemType",
              "#fenceOperationId": "operationId",
            },
            expressionAttributeValues: {
              ":fenceItemType": "erasure-fence",
              ":fenceOperationId": erasureOwner.operationId,
            },
          }
        : organizationWriteFenceCondition();
    const writesLanes = operations.some((operation) =>
      operation.kind === "condition-check"
        ? operation.key.pk === organizationKey.pk &&
          operation.key.sk.startsWith(`${key("ORGANIZATION-GATE-LANE")}#`)
        : isOrganizationGateLane(operation.record) &&
          operation.record.data.organizationId === organizationId,
    );
    if (existingFenceCheck) {
      if (
        typeof existingFenceCheck.conditionExpression !== "string" ||
        !["attribute_not_exists(pk)", UNIQUE_CLAIM_CONDITION].includes(
          existingFenceCheck.conditionExpression,
        ) ||
        Object.keys(existingFenceCheck.expressionAttributeNames ?? {}).length > 0 ||
        Object.keys(existingFenceCheck.expressionAttributeValues ?? {}).length > 0
      ) {
        return Effect.fail(
          databaseFailure(
            "transact-write",
            "control",
            "Organization erasure-fence condition keys are reserved for canonical write fencing.",
          ),
        );
      }
    }
    if (!writesLanes) {
      const organizationGateChecks = gateChecks.filter(
        ({ gate }) => gate.organizationId === organizationId,
      );
      augmentedOperations = augmentedOperations.filter(
        (operation) =>
          operation !== existingFenceCheck &&
          !organizationGateChecks.some(({ check }) => check === operation),
      );
      augmentedOperations.push(
        organizationGateLaneCheck({
          fence:
            erasureOwner?.organizationId === organizationId
              ? { kind: "erasure-owner", operationId: erasureOwner.operationId }
              : { kind: "tenant", observedAt: new Date().toISOString() },
          lane,
          organizationId,
          requirements: organizationGateChecks.map(({ gate }) => gate.requirement),
        }),
      );
      continue;
    }
    if (existingFenceCheck) {
      const existingFenceIndex = augmentedOperations.indexOf(existingFenceCheck);
      augmentedOperations[existingFenceIndex] = {
        ...existingFenceCheck,
        ...fenceCondition,
      };
    } else {
      augmentedOperations.push({
        ...fenceCondition,
        key: fenceKey,
        kind: "condition-check",
        table: "control",
      });
    }

    const organizationTarget = augmentedOperations.find((operation) => {
      const target =
        operation.kind === "condition-check"
          ? operation.key
          : { pk: operation.record.pk, sk: operation.record.sk };
      return target.pk === organizationKey.pk && target.sk === organizationKey.sk;
    });
    if (organizationTarget?.kind === "condition-check") {
      const organizationTargetIndex = augmentedOperations.indexOf(organizationTarget);
      augmentedOperations[organizationTargetIndex] = {
        ...organizationTarget,
        conditionExpression:
          organizationTarget.conditionExpression === "attribute_exists(pk)"
            ? organizationTarget.conditionExpression
            : `(${organizationTarget.conditionExpression}) AND attribute_exists(pk)`,
      };
    } else if (!organizationTarget) {
      augmentedOperations.push({
        conditionExpression: "attribute_exists(pk)",
        key: organizationKey,
        kind: "condition-check",
        table: "control",
      });
    }
  }

  return Effect.succeed(augmentedOperations);
}

export function withinTransactionItemLimit(
  operations: readonly TransactionOperation[],
): Effect.Effect<readonly TransactionOperation[], DatabaseError> {
  return operations.length > 100
    ? Effect.fail(
        databaseFailure(
          "transact-write",
          "multiple",
          "DynamoDB transactions support at most 100 operations after invariant checks.",
        ),
      )
    : Effect.succeed(operations);
}

export function validateTransactionInvariants(
  operations: readonly TransactionOperation[],
  erasureOwner?: { readonly operationId: string; readonly organizationId: string },
): Effect.Effect<readonly TransactionOperation[], DatabaseError> {
  return transactionInvariantOperations(operations, erasureOwner).pipe(
    Effect.flatMap(withinTransactionItemLimit),
  );
}

/** {@link validateTransactionInvariants} without the 100-item limit, so callers can size a transaction. */
export function transactionInvariantOperations(
  operations: readonly TransactionOperation[],
  erasureOwner?: { readonly operationId: string; readonly organizationId: string },
): Effect.Effect<readonly TransactionOperation[], DatabaseError> {
  const augmentedOperations = [...operations];
  const puts = operations.filter(
    (operation): operation is TransactionPut => operation.kind === "put",
  );
  const claimPuts = puts.filter(
    (operation): operation is UniqueClaimPut => operation.record.itemType === "unique-claim",
  );
  const deletes = operations.filter(
    (operation): operation is TransactionDelete => operation.kind === "delete",
  );
  const claimDeletes = deletes.filter(
    (operation): operation is UniqueClaimDelete => operation.record.itemType === "unique-claim",
  );
  const authorizedClaimDeletes = new Set<TransactionDelete>();
  const semanticEventPuts = puts.filter(
    (operation): operation is TransactionPut & { readonly record: SemanticEventRecord } =>
      operation.record.itemType === "semantic-event",
  );
  const appendOnlyItemTypes = new Set([
    "audit-event",
    "callback-dispatch-evidence",
    "identity-security-event",
    "immutable-audit-export",
    "installation-deployment",
    "model-invocation",
    "semantic-event",
  ]);

  const identityViolation = identityTransactionInvariantViolation(operations);
  if (identityViolation) return Effect.fail(identityViolation);

  const appendOnlyDelete = deletes.find((operation) =>
    appendOnlyItemTypes.has(operation.record.itemType),
  );
  if (appendOnlyDelete) {
    return Effect.fail(
      databaseFailure(
        "transact-write",
        tableForItemType(appendOnlyDelete.record.itemType),
        `${appendOnlyDelete.record.itemType} records are append-only and cannot be deleted.`,
      ),
    );
  }

  const semanticAggregatePartitions = new Set<string>();
  for (const operation of semanticEventPuts) {
    if (semanticAggregatePartitions.has(operation.record.pk)) {
      return Effect.fail(
        databaseFailure(
          "transact-write",
          "events",
          "One transaction may append at most one semantic event per aggregate.",
        ),
      );
    }
    semanticAggregatePartitions.add(operation.record.pk);

    const predecessorCheck = semanticEventPredecessorCheck(operation.record, operations);
    if (!predecessorCheck) continue;
    const existingIndex = augmentedOperations.findIndex(
      (candidate) =>
        candidate.kind === "condition-check" &&
        candidate.table === "events" &&
        candidate.key.pk === predecessorCheck.key.pk &&
        candidate.key.sk === predecessorCheck.key.sk,
    );
    if (existingIndex >= 0) {
      return Effect.fail(
        databaseFailure(
          "transact-write",
          "events",
          "Semantic event predecessor condition keys are reserved for append sequencing.",
        ),
      );
    }
    augmentedOperations.push(predecessorCheck);
  }

  for (const operation of puts) {
    if (operation.record.itemType !== "unique-claim") {
      continue;
    }

    const claim = operation.record.data;
    const { ownerId, ownerItemType } = claim;
    const hasOwner = puts.some(
      (candidate) =>
        candidate !== operation &&
        candidate.record.itemType === ownerItemType &&
        recordId(candidate.record) === ownerId &&
        uniqueClaimRequirements(candidate.record).some((requirement) =>
          claimMatches(claim, requirement),
        ),
    );
    if (!hasOwner) {
      return Effect.fail(
        databaseFailure(
          "transact-write",
          "control",
          `Unique claim ${claim.namespace}:${claim.value} is not derived from owner ${ownerItemType}:${ownerId}.`,
        ),
      );
    }
  }

  for (const operation of puts) {
    if (operation.record.itemType === "unique-claim") continue;
    if (
      operation.record.itemType === "audit-event" ||
      operation.record.itemType === "callback-dispatch-evidence" ||
      operation.record.itemType === "immutable-audit-export" ||
      operation.record.itemType === "installation-deployment" ||
      operation.record.itemType === "model-invocation"
    ) {
      if (operation.previousRecord || operation.allowExisting || operation.replaceExpired) {
        return Effect.fail(
          databaseFailure(
            "transact-write",
            tableForItemType(operation.record.itemType),
            `${operation.record.itemType} records only support create-only appends.`,
          ),
        );
      }
      const operationIndex = augmentedOperations.indexOf(operation);
      augmentedOperations[operationIndex] = withCreateOnlyCondition(operation);
    }

    const currentRequirements = uniqueClaimRequirements(operation.record);
    let previousRequirements: readonly UniqueClaimRequirement[] = [];

    if (operation.replaceExpired) {
      if (
        operation.previousRecord ||
        operation.allowExisting ||
        !isExpiredIdempotencyReplacement(operation)
      ) {
        return Effect.fail(
          databaseFailure(
            "transact-write",
            "events",
            "Expired replacement is restricted to the canonical idempotency condition.",
          ),
        );
      }
    } else if (operation.previousRecord) {
      const resolvesPrincipalScopedIdempotency =
        operation.previousRecord.itemType === "idempotency" &&
        operation.record.itemType === "idempotency" &&
        operation.previousRecord.data.status === "in-progress" &&
        operation.record.data.status === "completed" &&
        operation.previousRecord.data.organizationId === undefined &&
        typeof operation.record.data.organizationId === "string" &&
        typeof operation.previousRecord.data.principalId === "string" &&
        operation.record.data.principalId === operation.previousRecord.data.principalId &&
        hasSameImmutableIdentity(operation.previousRecord, {
          ...operation.record,
          data: { ...operation.record.data, organizationId: undefined },
        });
      const enrichesLegacyRateLimitScope =
        operation.previousRecord.itemType === "rate-limit-counter" &&
        operation.record.itemType === "rate-limit-counter" &&
        operation.previousRecord.data.organizationId === undefined &&
        typeof operation.record.data.organizationId === "string" &&
        hasSameImmutableIdentity(operation.previousRecord, {
          ...operation.record,
          data: { ...operation.record.data, organizationId: undefined },
        });
      if (
        operation.previousRecord.itemType !== operation.record.itemType ||
        operation.previousRecord.pk !== operation.record.pk ||
        operation.previousRecord.sk !== operation.record.sk ||
        (!hasSameImmutableIdentity(operation.previousRecord, operation.record) &&
          !resolvesPrincipalScopedIdempotency &&
          !enrichesLegacyRateLimitScope)
      ) {
        return Effect.fail(
          databaseFailure(
            "transact-write",
            "control",
            "previousRecord must identify the same resource as the replacement record.",
          ),
        );
      }

      previousRequirements = uniqueClaimRequirements(operation.previousRecord);
      const previousVersion = recordVersion(operation.previousRecord);
      const replacementVersion = recordVersion(operation.record);
      if (previousVersion === undefined || replacementVersion !== previousVersion + 1) {
        return Effect.fail(
          databaseFailure(
            "transact-write",
            tableForItemType(operation.record.itemType),
            "Replacement records must advance an integer version by exactly one.",
          ),
        );
      }
      const operationIndex = augmentedOperations.indexOf(operation);
      augmentedOperations[operationIndex] = withStoredDataFieldsCondition(
        withStoredImmutableIdentityCondition(
          withRecordVersionCondition(operation, previousVersion),
          operation.previousRecord,
          resolvesPrincipalScopedIdempotency || enrichesLegacyRateLimitScope
            ? ["organizationId"]
            : [],
        ),
        uniqueOwnerAttributes(operation.previousRecord),
      );
    } else if (operation.allowExisting) {
      if (
        isCanonicalMemorySearchTargetDirectoryPut(operation) ||
        isCanonicalGovernanceTenantDirectoryPut(operation)
      ) {
        continue;
      }
      const names = operation.expressionAttributeNames;
      const values = operation.expressionAttributeValues;
      if (
        operation.record.itemType !== "run-locator" ||
        operation.conditionExpression !== RUN_LOCATOR_UPSERT_CONDITION ||
        Object.keys(names ?? {}).length !== 4 ||
        names?.["#locatorData"] !== "data" ||
        names?.["#locatorItemType"] !== "itemType" ||
        names?.["#locatorRunPk"] !== "runPk" ||
        names?.["#locatorRunSk"] !== "runSk" ||
        Object.keys(values ?? {}).length !== 3 ||
        values?.[":locatorItemType"] !== "run-locator" ||
        values?.[":locatorRunPk"] !== operation.record.data.runPk ||
        values?.[":locatorRunSk"] !== operation.record.data.runSk
      ) {
        return Effect.fail(
          databaseFailure(
            "transact-write",
            tableForItemType(operation.record.itemType),
            "Only conditionally idempotent generated locator puts may allow an existing record.",
          ),
        );
      }
    } else {
      const operationIndex = augmentedOperations.indexOf(operation);
      augmentedOperations[operationIndex] = withCreateOnlyCondition(operation);
    }

    for (const requiredClaim of currentRequirements) {
      const unchanged = previousRequirements.some((claim) => claimMatches(claim, requiredClaim));
      const matchingClaimPut = claimPuts.find((claim) =>
        claimMatches(claim.record.data, requiredClaim),
      );

      if (unchanged) {
        if (matchingClaimPut) {
          return Effect.fail(
            databaseFailure(
              "transact-write",
              "control",
              `Unchanged unique claim ${requiredClaim.namespace}:${requiredClaim.value} must be checked, not recreated.`,
            ),
          );
        }

        const expectedKey = Keys.control.uniqueClaim(requiredClaim.namespace, requiredClaim.value);
        const existingCheckIndex = augmentedOperations.findIndex(
          (candidate) =>
            candidate.kind === "condition-check" &&
            candidate.table === "control" &&
            candidate.key.pk === expectedKey.pk &&
            candidate.key.sk === expectedKey.sk,
        );
        if (existingCheckIndex >= 0) {
          augmentedOperations[existingCheckIndex] = withClaimOwnerCondition(
            augmentedOperations[existingCheckIndex] as TransactionConditionCheck,
            requiredClaim,
          );
        } else {
          augmentedOperations.push(
            withClaimOwnerCondition(
              {
                conditionExpression: "attribute_exists(pk)",
                key: expectedKey,
                kind: "condition-check",
                table: "control",
              },
              requiredClaim,
            ),
          );
        }
      } else if (!matchingClaimPut) {
        return Effect.fail(
          databaseFailure(
            "transact-write",
            "control",
            `Resource ${requiredClaim.ownerItemType}:${requiredClaim.ownerId} is missing unique claim ${requiredClaim.namespace}:${requiredClaim.value}.`,
          ),
        );
      }
    }

    if (!operation.previousRecord) continue;

    const currentClaimKeys = new Set(
      currentRequirements.map((claim) => `${claim.namespace}\u0000${claim.value}`),
    );
    for (const previousClaim of previousRequirements) {
      if (currentClaimKeys.has(`${previousClaim.namespace}\u0000${previousClaim.value}`)) continue;
      const expectedKey = Keys.control.uniqueClaim(previousClaim.namespace, previousClaim.value);
      const releaseIndex = augmentedOperations.findIndex(
        (candidate) =>
          candidate.kind === "delete" &&
          candidate.record.itemType === "unique-claim" &&
          candidate.record.pk === expectedKey.pk &&
          candidate.record.sk === expectedKey.sk,
      );
      if (releaseIndex < 0) {
        return Effect.fail(
          databaseFailure(
            "transact-write",
            "control",
            `Changed unique value must release ${previousClaim.namespace}:${previousClaim.value}.`,
          ),
        );
      }
      augmentedOperations[releaseIndex] = withClaimOwnerCondition(
        augmentedOperations[releaseIndex] as TransactionDelete,
        previousClaim,
      );
      authorizedClaimDeletes.add(operations[releaseIndex] as TransactionDelete);
    }
  }

  for (const operation of deletes) {
    if (operation.record.itemType === "unique-claim") continue;

    const operationIndex = augmentedOperations.indexOf(operation);
    if (operation.allowMissing) {
      if (
        (operation.record.itemType !== "run-locator" &&
          operation.record.itemType !== "memory-search-target-record" &&
          operation.record.itemType !== "governance-tenant-record" &&
          operation.record.itemType !== "governance-legacy-record") ||
        operation.conditionExpression !== undefined
      ) {
        return Effect.fail(
          databaseFailure(
            "transact-write",
            tableForItemType(operation.record.itemType),
            "Only unconditional generated locator cleanup may tolerate a missing record.",
          ),
        );
      }
      continue;
    }
    const version = recordVersion(operation.record);
    const versionedOperation =
      version === undefined ? operation : withRecordVersionCondition(operation, version);
    augmentedOperations[operationIndex] = withStoredImmutableIdentityCondition(
      versionedOperation,
      operation.record,
    );

    augmentedOperations[operationIndex] = withStoredDataFieldsCondition(
      augmentedOperations[operationIndex] as TransactionDelete,
      uniqueOwnerAttributes(operation.record),
    );

    const requirements = uniqueClaimRequirements(operation.record);
    if (requirements.length === 0) continue;

    if (version === undefined) {
      return Effect.fail(
        databaseFailure(
          "transact-write",
          tableForItemType(operation.record.itemType),
          "Unique-bearing resource deletes require an integer record version.",
        ),
      );
    }
    for (const requirement of requirements) {
      const claimDeleteIndex = operations.findIndex(
        (candidate) =>
          candidate.kind === "delete" &&
          candidate.record.itemType === "unique-claim" &&
          claimMatches(candidate.record.data, requirement),
      );
      if (claimDeleteIndex < 0) {
        return Effect.fail(
          databaseFailure(
            "transact-write",
            "control",
            `Deleting ${requirement.ownerItemType}:${requirement.ownerId} requires deleting unique claim ${requirement.namespace}:${requirement.value}.`,
          ),
        );
      }
      const claimDelete = operations[claimDeleteIndex] as UniqueClaimDelete;
      augmentedOperations[claimDeleteIndex] = withClaimOwnerCondition(
        augmentedOperations[claimDeleteIndex] as TransactionDelete,
        requirement,
      );
      authorizedClaimDeletes.add(claimDelete);
    }
  }

  for (const claimDelete of claimDeletes) {
    if (!authorizedClaimDeletes.has(claimDelete)) {
      return Effect.fail(
        databaseFailure(
          "transact-write",
          "control",
          "Unique claims may only be deleted with their owner or as part of a validated unique-value change.",
        ),
      );
    }
  }

  return withOrganizationErasureFences(augmentedOperations, erasureOwner);
}
