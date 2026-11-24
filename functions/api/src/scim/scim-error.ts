import type { DirectoryRefusal } from "@deployments-ai/db";

/** The `scimType` values this service answers with (RFC 7644 §3.12, table 9). */
export type ScimType =
  | "invalidFilter"
  | "invalidPath"
  | "invalidSyntax"
  | "invalidValue"
  | "mutability"
  | "noTarget"
  | "uniqueness";

/** One SCIM Error response. Parsing returns it in place of a value; rendering writes it out. */
export class ScimError {
  readonly detail: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly scimType: ScimType | undefined;
  readonly status: number;

  constructor(input: {
    readonly detail: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly scimType?: ScimType;
    readonly status: number;
  }) {
    this.detail = input.detail;
    this.headers = input.headers ?? {};
    this.scimType = input.scimType;
    this.status = input.status;
  }
}

export function invalidValue(detail: string) {
  return new ScimError({ detail, scimType: "invalidValue", status: 400 });
}

export function invalidSyntax(detail: string) {
  return new ScimError({ detail, scimType: "invalidSyntax", status: 400 });
}

export const REFUSAL_ERRORS: { readonly [Reason in DirectoryRefusal]: ScimError } = {
  email_domain_not_verified: invalidValue(
    "The email domain is not a verified login domain of this organization.",
  ),
  external_id_taken: new ScimError({
    detail: "Another user in this organization already has this externalId.",
    scimType: "uniqueness",
    status: 409,
  }),
  principal_ineligible: new ScimError({
    detail: "This account cannot be provisioned by a directory.",
    status: 403,
  }),
  protected_role: new ScimError({
    detail: "Owners and admins are managed in the console, not through SCIM.",
    status: 403,
  }),
  user_exists: new ScimError({
    detail: "A user with this userName or email address already exists in this organization.",
    scimType: "uniqueness",
    status: 409,
  }),
  user_not_found: new ScimError({ detail: "User not found.", status: 404 }),
};
