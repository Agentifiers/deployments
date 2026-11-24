export class BrainUploadQuotaExceededError extends Error {
  readonly code = "brain_upload_quota_exceeded";
  readonly status = 429;

  constructor(readonly limitKey: string) {
    super(`Brain upload quota exceeded for ${limitKey}.`);
    this.name = "BrainUploadQuotaExceededError";
  }
}

export type BrainExtractionLimit =
  | "chunk count limit"
  | "normalized byte limit"
  | "page or segment limit"
  | "raw byte limit"
  | "token limit";

export class BrainExtractionLimitError extends Error {
  readonly code = "brain_extraction_limit_exceeded";

  constructor(readonly limit: BrainExtractionLimit) {
    super(`Brain extraction exceeded ${limit}.`);
    this.name = "BrainExtractionLimitError";
  }
}

export class BrainExtractionDurationError extends Error {
  readonly code = "brain_extraction_limit_exceeded";

  constructor() {
    super("Brain extraction exceeded extraction and embedding duration.");
    this.name = "BrainExtractionDurationError";
  }
}

export class BrainExtractionUnusableError extends Error {
  readonly code = "brain_extraction_unusable";

  constructor(readonly reason: string) {
    super(`Brain document text could not be extracted: ${reason}.`);
    this.name = "BrainExtractionUnusableError";
  }
}

export class BrainIndexRejectedBeforeWriteError extends Error {
  readonly code = "brain_index_rejected_before_write";

  constructor(rejection: BrainExtractionLimitError | BrainExtractionUnusableError) {
    super(rejection.message, { cause: rejection });
    this.name = "BrainIndexRejectedBeforeWriteError";
  }
}

export function rethrowRejectedBeforeWrite(cause: unknown): never {
  if (cause instanceof BrainExtractionLimitError || cause instanceof BrainExtractionUnusableError) {
    throw new BrainIndexRejectedBeforeWriteError(cause);
  }
  throw cause;
}

export class BrainIndexStaleError extends Error {
  readonly code = "brain_index_stale";

  constructor() {
    super("Brain index input is no longer the current canonical document version.");
    this.name = "BrainIndexStaleError";
  }
}

export class BrainIndexComponentError extends Error {
  readonly code = "brain_index_component_incomplete";

  constructor(readonly components: readonly string[]) {
    super(`Brain index components are incomplete: ${components.join(", ")}.`);
    this.name = "BrainIndexComponentError";
  }
}

/** Bounded rejection classes; never carry model output or evidence. */
export type BrainAnswerRejection =
  | "citation-outside-context"
  | "empty-content"
  | "invalid-claim-citations"
  | "invalid-claim-text"
  | "invalid-claims"
  | "invalid-gaps"
  | "malformed-json"
  | "non-object-json"
  | "uncited-claim";

/** The answer model produced output that failed validation; an upstream fault, not the caller's. */
export class BrainAnswerInvalidError extends Error {
  readonly code = "brain_answer_invalid";
  readonly status = 502;

  constructor(readonly rejection: BrainAnswerRejection) {
    super("The Brain answer model returned an invalid answer.");
    this.name = "BrainAnswerInvalidError";
  }
}
