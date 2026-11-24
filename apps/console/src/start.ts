import { createSerializationAdapter } from "@tanstack/react-router";
import { createCsrfMiddleware, createStart } from "@tanstack/react-start";
import { PlatformApiError, UnauthenticatedError, type PlatformProblem } from "./errors.ts";

const unauthenticatedErrorAdapter = createSerializationAdapter({
  fromSerializable: (message: string) => new UnauthenticatedError(message),
  key: "console-unauthenticated-error",
  test: (value): value is UnauthenticatedError => value instanceof UnauthenticatedError,
  toSerializable: (error) => error.message,
});

const platformApiErrorAdapter = createSerializationAdapter({
  fromSerializable: (value: { operation: string; problem: PlatformProblem }) =>
    new PlatformApiError(value.operation, value.problem),
  key: "console-platform-api-error",
  test: (value): value is PlatformApiError => value instanceof PlatformApiError,
  toSerializable: (error) => ({ operation: error.operation, problem: error.problem }),
});

/**
 * Server functions act with the caller's session cookie, so cross-site requests to them are
 * refused: `Sec-Fetch-Site` must be `same-origin`, or `Origin`/`Referer` must match the console.
 */
const csrfMiddleware = createCsrfMiddleware({
  filter: (context) => context.handlerType === "serverFn",
});

/** Typed errors keep their class across server functions and SSR hydration. */
export const startInstance = createStart(() => ({
  requestMiddleware: [csrfMiddleware],
  serializationAdapters: [unauthenticatedErrorAdapter, platformApiErrorAdapter],
}));
