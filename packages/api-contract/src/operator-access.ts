import { Schema } from "effect";
import { Cursor, PublicId, Slug, Timestamp } from "./primitives.ts";

export const OPERATOR_ACCESS_DEFAULT_MINUTES = 60;
export const OPERATOR_ACCESS_MAXIMUM_MINUTES = 480;
export const OPERATOR_ACCESS_STATUSES = ["closed", "expired", "open"] as const;

const NonBlank = (maximum: number) =>
  Schema.String.pipe(
    Schema.check(
      Schema.makeFilter<string>((input) =>
        input.trim().length > 0 ? undefined : "Expected a non-blank string.",
      ),
      Schema.isMaxLength(maximum),
    ),
  );

export const OpenSystemOrganizationAccessRequest = Schema.Struct({
  durationMinutes: Schema.optional(
    Schema.Number.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(1),
        Schema.isLessThanOrEqualTo(OPERATOR_ACCESS_MAXIMUM_MINUTES),
      ),
    ).annotate({
      description: `How long access stays open, in minutes. Defaults to ${OPERATOR_ACCESS_DEFAULT_MINUTES}; at most ${OPERATOR_ACCESS_MAXIMUM_MINUTES}.`,
    }),
  ),
  reason: NonBlank(500).annotate({
    description: "Why you need the organization's data; shown in its audit log.",
  }),
  ticket: Schema.optional(
    NonBlank(200).annotate({ description: "A support ticket or case reference." }),
  ),
});

export const SystemOrganizationAccessResponse = Schema.Struct({
  closedAt: Schema.NullOr(Timestamp),
  expiresAt: Timestamp,
  grantId: PublicId.annotate({
    description:
      "Stays the same across renewals; a new open after a close or expiry gets a new one.",
  }),
  openedAt: Timestamp,
  organizationId: PublicId,
  principalId: PublicId,
  reason: Schema.String,
  status: Schema.Literals(OPERATOR_ACCESS_STATUSES).annotate({
    description: "Only open access lets a platform administrator read the organization's data.",
  }),
  ticket: Schema.NullOr(Schema.String),
});

export const GetSystemOrganizationAccessResponse = Schema.Struct({
  access: Schema.NullOr(SystemOrganizationAccessResponse).annotate({
    description:
      "The caller's latest access to the organization, or null if they never opened any.",
  }),
  organization: Schema.Struct({
    id: PublicId,
    name: Schema.String,
    slug: Slug,
    status: Schema.Literals(["active", "archived", "disabled"]),
  }).annotate({
    description: "What an operator sees of the organization before opening access to its data.",
  }),
});

export const OpenSystemOrganizationAccessResponse = Schema.Struct({
  access: SystemOrganizationAccessResponse,
  renewed: Schema.Boolean.annotate({
    description: "true when access was already open and this extended it.",
  }),
});

export const CloseSystemOrganizationAccessResponse = Schema.Struct({
  access: Schema.NullOr(SystemOrganizationAccessResponse),
  changed: Schema.Boolean.annotate({
    description: "false when no access was open, so nothing was written.",
  }),
});

export const ListSystemOperatorAccessResponse = Schema.Struct({
  items: Schema.Array(SystemOrganizationAccessResponse),
  nextCursor: Schema.NullOr(Cursor),
});
