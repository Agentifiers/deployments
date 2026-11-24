/**
 * Errors that cross the server-function boundary. They are registered as serialization adapters
 * in `start.ts`, so route error components receive real instances on the server and the client.
 */

/** The request has no usable platform session; the UI renders the sign-in state. */
export class UnauthenticatedError extends Error {
  constructor(message = "Sign in to continue.") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}

/** RFC 7807 envelope returned by the platform API, as rendered by the console. */
export interface PlatformProblem {
  readonly code?: string;
  readonly detail?: string;
  readonly instance?: string;
  readonly requestId?: string;
  /** The response's `Retry-After` header, when it gave a delay in seconds that a timer can hold. */
  readonly retryAfterSeconds?: number;
  readonly status: number;
  readonly title: string;
  readonly type?: string;
}

/** A platform API operation failed with a problem response. */
export class PlatformApiError extends Error {
  readonly operation: string;
  readonly problem: PlatformProblem;

  constructor(operation: string, problem: PlatformProblem) {
    super(problem.detail ?? problem.title);
    this.name = "PlatformApiError";
    this.operation = operation;
    this.problem = problem;
  }
}

/** A console-made problem code: the upload cannot finish under its key, so the next one starts over. */
export const BRAIN_UPLOAD_RESTART = "brain_upload_restart";
