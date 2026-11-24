import { Data } from "effect";

export class CliProcessError extends Data.TaggedError("CliProcessError")<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

export class HttpRequestError extends Data.TaggedError("HttpRequestError")<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

export class E2eConfigurationError extends Data.TaggedError("E2eConfigurationError")<{
  readonly cause?: unknown;
  readonly message: string;
}> {}
