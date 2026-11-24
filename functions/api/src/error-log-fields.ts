/** Bounded diagnostic fields for an unexpected failure: its error type and message. */
export function errorLogFields(cause: unknown) {
  return {
    error: cause instanceof Error ? cause.message : "Unknown error.",
    errorType: cause instanceof Error ? cause.name : typeof cause,
  };
}
