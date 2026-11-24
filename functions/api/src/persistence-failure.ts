import { PersistenceError } from "@deployments-ai/db";

export function failure(
  kind: ConstructorParameters<typeof PersistenceError>[0],
  code: string,
  message: string,
): never {
  throw new PersistenceError(kind, code, message);
}
