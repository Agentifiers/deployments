import { PersistenceError } from "@deployments-ai/db";

export function invalidQuery(name: string, expected: string) {
  return new PersistenceError(
    "invalid-input",
    "invalid_query_parameter",
    `${name} must be ${expected}.`,
  );
}
