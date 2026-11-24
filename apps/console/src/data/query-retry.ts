import { isNotFound } from "@tanstack/react-router";
import { PlatformApiError, UnauthenticatedError } from "../errors.ts";

/** Session, contract, and Not found outcomes are final; only transient failures get two more attempts. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (
    error instanceof UnauthenticatedError ||
    error instanceof PlatformApiError ||
    isNotFound(error)
  ) {
    return false;
  }
  return failureCount < 2;
}
