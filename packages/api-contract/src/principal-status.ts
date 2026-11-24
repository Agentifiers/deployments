import { Schema } from "effect";
import { PublicId, Timestamp } from "./primitives.ts";

export const SYSTEM_PRINCIPAL_STATUSES = ["active", "disabled"] as const;

const PrincipalStatus = Schema.Literals(SYSTEM_PRINCIPAL_STATUSES).annotate({
  description:
    "disabled refuses the person's credentials and ends their sessions; active restores sign-in.",
});

export const ReplaceSystemPrincipalStatusRequest = Schema.Struct({
  reason: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter<string>((input) =>
        input.trim().length > 0 ? undefined : "Expected a non-blank string.",
      ),
      Schema.isMaxLength(500),
    ),
  ).annotate({ description: "Why the status changes; recorded in the person's security events." }),
  status: PrincipalStatus,
});

export const SystemPrincipalStatusResponse = Schema.Struct({
  changed: Schema.Boolean.annotate({
    description: "false when the person already had the requested status, so nothing was written.",
  }),
  principalId: PublicId,
  status: PrincipalStatus,
  updatedAt: Timestamp,
});
