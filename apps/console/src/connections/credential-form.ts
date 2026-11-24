import type { KeyedSnapshot } from "../components/keyed-snapshot.ts";
import { PlatformApiError } from "../errors.ts";

/** One credential field a provider declares, as the console renders it. */
export interface CredentialFieldView {
  readonly key: string;
  readonly label: string;
  readonly description?: string;
  readonly required: boolean;
  readonly sensitive: boolean;
  /** JSON fields, such as a service account document, get a multi-line input. */
  readonly multiline: boolean;
  /** The API fills an empty field with this value. */
  readonly defaultValue?: string;
}

export type CredentialDocument =
  | { readonly ok: true; readonly credential?: Readonly<Record<string, string>> }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * The `credential` body for the provider's fields from the form's values, trimmed. Empty
 * optional fields are left out. A provider without fields takes no credential at all.
 */
export function credentialDocument(
  fields: readonly CredentialFieldView[],
  values: Readonly<Record<string, string>>,
): CredentialDocument {
  if (fields.length === 0) return { ok: true };
  const entries = fields.flatMap((field) => {
    const value = values[field.key]?.trim() ?? "";
    return value === "" ? [] : [[field.key, value] as const];
  });
  const provided = new Set(entries.map(([key]) => key));
  const problems = fields
    .filter(
      (field) => field.required && field.defaultValue === undefined && !provided.has(field.key),
    )
    .map((field) => `${field.label} is required.`);
  return problems.length > 0
    ? { ok: false, problems }
    : { credential: Object.fromEntries(entries), ok: true };
}

export interface RotationBody {
  readonly credential: Readonly<Record<string, string>>;
  readonly expectedVersion: number;
}

/** A rotation body and the idempotency key it goes out with. */
export type RotationRequest = KeyedSnapshot<RotationBody>;

const conflicted = (error: unknown) =>
  error instanceof PlatformApiError &&
  (error.problem.code === "version_conflict" || error.problem.code === "rotation_cleanup_pending");

/**
 * Sends one rotate dialog's requests. A rotation's first write bumps the version and binds its
 * cleanup to that request's body and idempotency key: the API refuses any other request with
 * `rotation_cleanup_pending` until the same request finishes it, and that request may conflict
 * again in the cleanup. So a `version_conflict` retries the request once. A refusal does not show
 * the version moved, because a cancelled first write also answers `version_conflict`. So after
 * either refusal, if the dialog sent earlier requests, the sender reads the connection's version
 * and resends, newest first, only those read below it, until one is not refused. A request that
 * started a rotation was read below the version its write left, so it is resent to finish or
 * replay; the others conflict, because the version never goes back. A request read at the live
 * version could start a second rotation with a credential the operator replaced, so it is never
 * resent.
 */
export function rotationSender(liveVersion: () => Promise<number>) {
  let sent: readonly RotationRequest[] = [];
  return async <Result>(
    request: RotationRequest,
    send: (request: RotationRequest) => Promise<Result>,
  ): Promise<Result> => {
    const once = (candidate: RotationRequest) =>
      send(candidate).catch((error: unknown) => {
        if (error instanceof PlatformApiError && error.problem.code === "version_conflict") {
          return send(candidate);
        }
        throw error;
      });
    // A resend carries the body object `snapshotFor` held, so identity tells it from a new body.
    const earlier = sent.filter(
      (candidate) => candidate.key !== request.key || candidate.value !== request.value,
    );
    sent = [...earlier, request];
    try {
      return await once(request);
    } catch (refusal) {
      if (!conflicted(refusal) || earlier.length === 0) throw refusal;
      const version = await liveVersion();
      for (const candidate of earlier.toReversed()) {
        if (candidate.value.expectedVersion >= version) continue;
        try {
          return await once(candidate);
        } catch (error) {
          if (!conflicted(error)) throw error;
        }
      }
      throw refusal;
    }
  };
}
