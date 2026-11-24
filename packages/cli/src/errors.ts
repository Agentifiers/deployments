import {
  PlatformApiError,
  PlatformRequestError,
  PlatformTransportError,
} from "@agentifiers/deployments-sdk";
import { ExitCode, type ExitCodeValue } from "./exit-codes.ts";

export { ExitCode, type ExitCodeValue } from "./exit-codes.ts";

export class CliError extends Error {
  readonly exitCode: ExitCodeValue;

  constructor(message: string, exitCode: ExitCodeValue = ExitCode.unexpected) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
  }
}

export function exitCodeForError(error: unknown): ExitCodeValue {
  if (error instanceof CliError) return error.exitCode;
  if (error instanceof PlatformTransportError) return ExitCode.unavailable;
  if (error instanceof PlatformRequestError) return ExitCode.validation;
  if (typeof error === "object" && error !== null && "name" in error && error.name === "CLIError") {
    return ExitCode.usage;
  }
  if (!(error instanceof PlatformApiError)) return ExitCode.unexpected;
  const status = error.problem.status;
  if (status === 401) return ExitCode.authentication;
  if (status === 403) return ExitCode.forbidden;
  if (status === 404) return ExitCode.notFound;
  if (status === 409) return ExitCode.conflict;
  if (status === 400 || status === 422) return ExitCode.validation;
  if (status >= 500) return ExitCode.unavailable;
  return ExitCode.unexpected;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
