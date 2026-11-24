import type { PersistenceError } from "@deployments-ai/db";

export function persistenceStatus(error: PersistenceError) {
  switch (error.kind) {
    case "invalid-input":
      return 400;
    case "forbidden":
      return 403;
    case "not-found":
      return 404;
    case "conflict":
      return 409;
    case "unprocessable":
      return 422;
    case "internal":
      return 500;
  }
}
