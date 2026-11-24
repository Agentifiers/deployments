/** SSM `GetParameter` rejected because the parameter does not exist. */
export function isResourceNotFound(cause: unknown) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    cause.name === "ParameterNotFound"
  );
}

/** DynamoDB rejected a write because its condition expression did not hold. */
export function isConditionalCheckFailed(cause: unknown) {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "name" in cause &&
    cause.name === "ConditionalCheckFailedException"
  );
}
