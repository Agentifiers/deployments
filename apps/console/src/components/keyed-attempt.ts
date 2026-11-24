import { BRAIN_UPLOAD_RESTART, PlatformApiError } from "../errors.ts";

/**
 * The idempotency key a dialog's next submission sends, and which body goes with it. `fresh`: no
 * submission under the key may have applied. `resend`: the last one may have applied, so the next
 * repeats its body for the API to replay or finish. `reread`: an earlier one may have applied, but
 * the last body was refused and would be refused again, so the next reads live values. It keeps the
 * key, so the API answers `idempotency_conflict` instead of applying a second body.
 */
export interface KeyedAttempt {
  readonly key: string;
  readonly state: "fresh" | "resend" | "reread";
}

export function freshAttempt(): KeyedAttempt {
  return { key: crypto.randomUUID(), state: "fresh" };
}

/**
 * A failure without a problem response, a 5xx, or a key still running may have applied. A 403 or a
 * 429 applied nothing: it came before the API read the key or, for a 403, from a role check inside
 * the operation, which releases the key record. Neither judged the body, so the attempt stands as
 * it was and a resend still repeats a body that may have applied. Any other 4xx refused the body
 * itself: the operation, which releases the key record, the API's body decoding, the console's own
 * checks, or a key bound to another body.
 */
export function attemptAfterFailure(attempt: KeyedAttempt, error: unknown): KeyedAttempt {
  if (error instanceof PlatformApiError && error.problem.code === BRAIN_UPLOAD_RESTART) {
    return freshAttempt();
  }
  if (
    !(error instanceof PlatformApiError) ||
    error.problem.status >= 500 ||
    error.problem.code === "idempotency_in_progress"
  ) {
    return { key: attempt.key, state: "resend" };
  }
  const { status } = error.problem;
  if (status === 403 || status === 429) return attempt;
  return attempt.state === "fresh" ? freshAttempt() : { key: attempt.key, state: "reread" };
}

const RESEND_NOTICE =
  "The platform may have applied this request. The fields stay locked, and submitting again repeats it under the same key. If it applied and this page's data has changed since, the platform refuses the repeat as a conflict. To change the request, choose Leave unfinished, check whether it applied, and open the dialog again to start a new request.";

/**
 * What a dialog allows after its last submission. `locked`: a keyed (`run`) submission may have
 * applied, so the fields and dismissal lock and only Leave unfinished abandons the request.
 * `refused`: an unkeyed (`runOnce`) submission may have applied, so the dialog refuses another.
 */
export type DialogLock<Notice> =
  | { readonly kind: "editable" }
  | { readonly kind: "locked"; readonly notice: Notice | typeof RESEND_NOTICE }
  | { readonly kind: "refused" };

export function dialogLock<Notice>(
  submit: "run" | "runOnce",
  attempt: KeyedAttempt,
  retryNotice: Notice | null | undefined,
): DialogLock<Notice> {
  if (attempt.state !== "resend") return { kind: "editable" };
  return submit === "runOnce"
    ? { kind: "refused" }
    : { kind: "locked", notice: retryNotice ?? RESEND_NOTICE };
}
