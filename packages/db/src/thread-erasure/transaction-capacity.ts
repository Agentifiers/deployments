const TRANSACTION_OPERATION_LIMIT = 100;
const ORGANIZATION_CONDITION_OPERATIONS = 1;
const OPERATIONS_PER_STABLE_MUTATION = 2;

export function stableTenantMutationCapacity(namedThreadCount: number) {
  return Math.floor(
    (TRANSACTION_OPERATION_LIMIT - ORGANIZATION_CONDITION_OPERATIONS - namedThreadCount) /
      OPERATIONS_PER_STABLE_MUTATION,
  );
}
