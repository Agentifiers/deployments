import { Effect, Schema } from "effect";
import { EgressAllowlistEntry } from "./egress-allowlist.ts";
import { Cursor, PublicId, Timestamp } from "./primitives.ts";
import { ALL_PLAN_FEATURES, PlanFeatureGrant, PlanFeatureValues } from "./plan-features.ts";
import { TenantLimitOverrides, TenantLimitValues } from "./tenant-limits.ts";

const NAME = "[a-z0-9][a-z0-9-]{0,62}";
export const STANDING_NAME_PATTERN_SOURCE = `^${NAME}$`;
export const STANDING_HOLD_REASONS = ["payment", "abuse", "policy", "manual"] as const;

const StandingName = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(new RegExp(STANDING_NAME_PATTERN_SOURCE, "u"), {
      message:
        "Expected 1 to 63 lowercase letters, digits, or hyphens, not starting with a hyphen.",
    }),
  ),
);

function standingText(description: string) {
  return Schema.String.pipe(
    Schema.check(
      Schema.makeFilter<string>((input) =>
        input.trim().length > 0 ? undefined : "Expected a non-blank string.",
      ),
      Schema.isMaxLength(500),
    ),
  ).annotate({ description });
}

const CustomerMessage = standingText("Shown to the organization's members while the hold lasts.");
const OperatorNote = standingText("Seen only by operators and services; never by members.");
const ReleaseNote = standingText("Why the hold was released; recorded in the history.");

const DataBoundaryNote = standingText(
  "Why the data boundary changed, such as the agreement reference. Seen only by operators.",
);
export const DATA_BOUNDARY_PROFILES = ["phi"] as const;
const DataBoundaryProfile = Schema.Literals(DATA_BOUNDARY_PROFILES).annotate({
  description: "phi keeps tools off the public internet and models on Bedrock.",
});

const HoldReason = Schema.Literals(STANDING_HOLD_REASONS).annotate({
  description:
    "payment, abuse, policy, or manual. Enforcement derives how the organization halts from it.",
});

const OperatorActor = Schema.Struct({ kind: Schema.Literal("operator"), principalId: PublicId });
const ServiceActor = Schema.Struct({ kind: Schema.Literal("service"), service: StandingName });
const StandingActor = Schema.Union([OperatorActor, ServiceActor]);

const StandingSource = Schema.String.pipe(
  Schema.check(Schema.isPattern(new RegExp(`^(?:operator|service:${NAME})$`, "u"))),
).annotate({ description: "operator, or service:<name> for a machine service." });

export const ModelSpendCeiling = Schema.Union([
  Schema.Literal("unlimited"),
  Schema.Struct({
    monthlyUsdMicros: Schema.Number.pipe(
      Schema.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    ),
  }),
]).annotate({ description: "Monthly operator-funded model spend ceiling, or unlimited." });

/** What one source asserts. An absent field leaves it to the next source. */
const EntitlementGrantValues = Schema.Struct({
  features: Schema.optional(PlanFeatureGrant),
  operatorFundedModelSpendCeiling: Schema.optional(ModelSpendCeiling),
  tenantLimits: Schema.optional(TenantLimitOverrides),
});

const EntitlementValues = Schema.Struct({
  /** Defaults when absent, so a reader stays compatible with an API that predates features. */
  features: PlanFeatureValues.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(ALL_PLAN_FEATURES)),
  ),
  operatorFundedModelSpendCeiling: ModelSpendCeiling,
  tenantLimits: TenantLimitValues,
});

const StandingHold = Schema.Struct({
  customerMessage: CustomerMessage,
  key: StandingName,
  operatorNote: Schema.NullOr(OperatorNote),
  placedAt: Timestamp,
  placedBy: StandingActor,
  reason: HoldReason,
  source: StandingSource,
});

const SystemDataBoundary = Schema.Struct({
  operatorNote: DataBoundaryNote,
  profile: DataBoundaryProfile,
  setAt: Timestamp,
  setBy: OperatorActor,
});

const CustomerHold = Schema.Struct({
  customerMessage: CustomerMessage,
  reason: HoldReason,
  since: Timestamp,
});

export const OrganizationStandingResponse = Schema.Struct({
  /** Defaults when absent, so a reader stays compatible with an API that predates boundaries. */
  dataBoundary: Schema.NullOr(
    Schema.Struct({ profile: DataBoundaryProfile, since: Timestamp }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  effective: EntitlementValues,
  holds: Schema.Array(CustomerHold),
  organizationId: PublicId,
  state: Schema.Literals(["active", "suspended"]),
  suspendedAt: Schema.NullOr(Timestamp),
});

export const OrganizationSuspendedProblem = Schema.Struct({
  code: Schema.Literal("organization_suspended"),
  detail: Schema.String,
  holds: Schema.NonEmptyArray(CustomerHold),
  requestId: Schema.String,
  status: Schema.Literal(403),
  title: Schema.String,
  type: Schema.Literal("https://docs.deployments.ai/errors/organization-suspended"),
}).annotate({
  description:
    "Refusal of a change while the organization is suspended. Reads and remediation routes still answer.",
});

export const SystemOrganizationStandingResponse = Schema.Struct({
  dataBoundary: Schema.NullOr(SystemDataBoundary),
  defaults: EntitlementValues,
  effective: EntitlementValues,
  egressAllowlist: Schema.Array(EgressAllowlistEntry).annotate({
    description:
      "Origins the organization's admins let public-egress tools reach without approval inside its data boundary.",
  }),
  grants: Schema.Struct({
    operator: Schema.NullOr(
      Schema.Struct({
        entitlements: EntitlementGrantValues,
        grantedAt: Timestamp,
        grantedBy: OperatorActor,
      }),
    ),
    service: Schema.NullOr(
      Schema.Struct({
        entitlements: EntitlementGrantValues,
        grantedAt: Timestamp,
        grantedBy: ServiceActor,
      }),
    ),
  }),
  holds: Schema.Array(StandingHold),
  organizationId: PublicId,
  state: Schema.Literals(["active", "suspended"]),
  suspendedAt: Schema.NullOr(Timestamp),
  version: Schema.Number,
});

export const SystemOrganizationStandingChangeResponse = Schema.Struct({
  changed: Schema.Boolean.annotate({
    description: "false when the standing already matched the request, so nothing was written.",
  }),
  standing: SystemOrganizationStandingResponse,
});

export const ReplaceSystemOrganizationEntitlementsRequest = EntitlementGrantValues;

export const PlaceSystemOrganizationHoldRequest = Schema.Struct({
  customerMessage: CustomerMessage,
  operatorNote: Schema.optional(OperatorNote),
  reason: HoldReason,
});

export const ReleaseSystemOrganizationHoldRequest = Schema.Struct({
  releaseNote: Schema.optional(ReleaseNote),
});

export const SetSystemOrganizationDataBoundaryRequest = Schema.Struct({
  operatorNote: DataBoundaryNote,
  profile: DataBoundaryProfile,
});

export const ClearSystemOrganizationDataBoundaryRequest = Schema.Struct({
  operatorNote: DataBoundaryNote,
});

const StandingChange = Schema.Union([
  Schema.Struct({ hold: StandingHold, kind: Schema.Literal("hold-placed") }),
  Schema.Struct({
    hold: StandingHold,
    kind: Schema.Literal("hold-released"),
    releaseNote: Schema.NullOr(ReleaseNote),
  }),
  Schema.Struct({ entitlements: EntitlementGrantValues, kind: Schema.Literal("grant-set") }),
  Schema.Struct({ kind: Schema.Literal("grant-cleared") }),
  Schema.Struct({ dataBoundary: SystemDataBoundary, kind: Schema.Literal("data-boundary-set") }),
  Schema.Struct({
    kind: Schema.Literal("data-boundary-cleared"),
    operatorNote: DataBoundaryNote,
    profile: DataBoundaryProfile,
  }),
]);

export const ListSystemOrganizationStandingHistoryResponse = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      actor: StandingActor,
      change: StandingChange,
      occurredAt: Timestamp,
      state: Schema.Literals(["active", "suspended"]),
      version: Schema.Number,
    }),
  ),
  nextCursor: Schema.NullOr(Cursor),
});
