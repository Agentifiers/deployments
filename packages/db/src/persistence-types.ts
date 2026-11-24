import { Schema } from "effect";

export interface PersistenceIdentity {
  readonly authentication?: "api-credential" | "tenant-jwt";
  /** Set when the caller's token carries a signed `email_verified: true` claim. */
  readonly emailVerified?: true;
  readonly principalId: string;
  readonly scopes?: readonly string[];
  readonly organizationIds?: readonly string[] | "*";
  /** The open operator access grant a platform administrator was admitted under, if any. */
  readonly operatorAccess?: { readonly grantId: string; readonly organizationId: string };
  readonly platformRole?: "administrator";
  readonly projectIds?: readonly string[] | "*";
  readonly environmentIds?: readonly string[] | "*";
}

export interface PersistenceInvocation<Body = unknown> {
  readonly body: Body;
  readonly id?: string;
  readonly identity: PersistenceIdentity;
  readonly idempotencyKey?: string;
  readonly query: { readonly cursor?: string; readonly limit?: number };
  readonly scope: {
    readonly organizationId?: string;
    readonly projectId?: string;
    readonly environmentId?: string;
  };
}

export interface PersistenceListResult<Item> {
  readonly items: readonly Item[];
  readonly nextCursor?: string | null;
}

export const PersistenceFailureKind = Schema.Literals([
  "conflict",
  "forbidden",
  "internal",
  "invalid-input",
  "not-found",
  "unprocessable",
]);
export type PersistenceFailureKind = typeof PersistenceFailureKind.Type;

export class PersistenceError extends Schema.TaggedErrorClass<PersistenceError>()(
  "PersistenceError",
  {
    code: Schema.String,
    kind: PersistenceFailureKind,
    message: Schema.String,
  },
) {
  constructor(kind: PersistenceFailureKind, code: string, message: string) {
    super({ code, kind, message });
  }
}
