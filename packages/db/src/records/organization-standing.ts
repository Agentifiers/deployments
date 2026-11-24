import { TENANT_LIMIT_DEFINITIONS, type TenantLimitName } from "@deployments-ai/tenant-limits";
import { Schema } from "effect";
import { Ulid } from "../ids.ts";
import {
  NonEmptyString,
  NonNegativeSafeInteger,
  Timestamp,
  makeRecordSchema,
  mutableResourceFields,
} from "../record-schema.ts";
import {
  EGRESS_ALLOWLIST_MAX_ENTRIES,
  EGRESS_ALLOWLIST_NOTE_MAX_LENGTH,
  egressAllowlistIssues,
} from "../organization-standing/egress-allowlist-rules.ts";
import { SpendMonth } from "./usage.ts";

const NAME = "[a-z0-9][a-z0-9-]{0,62}";

function namePattern(brand: string) {
  return Schema.isPattern(new RegExp(`^${NAME}$`, "u"), {
    message: `Expected a ${brand}: lowercase letters, digits, and hyphens, at most 63 characters.`,
  });
}

/** Configured name of a machine principal that may write standing. */
export const ServiceName = Schema.String.pipe(
  Schema.check(namePattern("service name")),
  Schema.brand("ServiceName"),
);
export type ServiceName = typeof ServiceName.Type;

/** Caller-chosen name of a hold, unique per source. */
export const HoldKey = Schema.String.pipe(
  Schema.check(namePattern("hold key")),
  Schema.brand("HoldKey"),
);
export type HoldKey = typeof HoldKey.Type;

/** Who owns a hold or grant: `operator`, or `service:<name>` for a machine principal. */
export const StandingSource = Schema.String.pipe(
  Schema.check(
    Schema.isPattern(new RegExp(`^(?:operator|service:${NAME})$`, "u"), {
      message: "Expected operator or service:<name>.",
    }),
  ),
  Schema.brand("StandingSource"),
);
export type StandingSource = typeof StandingSource.Type;

export const HoldReason = Schema.Literals(["payment", "abuse", "policy", "manual"]);
export type HoldReason = typeof HoldReason.Type;

export const OperatorActor = Schema.Struct({
  kind: Schema.Literal("operator"),
  principalId: Ulid,
});
export const ServiceActor = Schema.Struct({
  kind: Schema.Literal("service"),
  service: ServiceName,
});
/** The authenticated caller. Its source owns whatever it places or grants. */
export const StandingActor = Schema.Union([OperatorActor, ServiceActor]);
export type StandingActor = typeof StandingActor.Type;

const decodeStandingSource = Schema.decodeSync(StandingSource);

export function standingSource(actor: StandingActor): StandingSource {
  return decodeStandingSource(actor.kind === "operator" ? "operator" : `service:${actor.service}`);
}

const StandingText = NonEmptyString.pipe(Schema.check(Schema.isMaxLength(500)));

export const ActiveHold = Schema.Struct({
  /** Shown to organization members. */
  customerMessage: StandingText,
  key: HoldKey,
  /** Never shown to organization members. */
  operatorNote: Schema.optional(StandingText),
  placedAt: Timestamp,
  placedBy: StandingActor,
  reason: HoldReason,
});
export type ActiveHold = typeof ActiveHold.Type;

export function holdSlot(source: StandingSource, key: HoldKey) {
  return `${source}/${key}`;
}

/**
 * How a suspended organization's running work halts. `drain` lets admitted runs finish; `stop`
 * cancels them at their next heartbeat. The hold reason decides it, never the caller.
 */
export const HaltMode = Schema.Literals(["drain", "stop"]);
export type HaltMode = typeof HaltMode.Type;

const HALT_MODE_BY_REASON = {
  abuse: "stop",
  manual: "stop",
  payment: "drain",
  policy: "stop",
} as const satisfies Record<HoldReason, HaltMode>;

/** Any hold that stops wins over holds that drain. */
export function haltMode(holds: readonly Pick<ActiveHold, "reason">[]): HaltMode {
  return holds.some((hold) => HALT_MODE_BY_REASON[hold.reason] === "stop") ? "stop" : "drain";
}

/**
 * Present exactly while at least one hold exists; holds are keyed `<source>/<key>`. `haltMode` is
 * derived from the holds and written with them, so a transaction condition can read it.
 */
export const OrganizationSuspension = Schema.Struct({
  haltMode: HaltMode,
  holds: Schema.Record(Schema.String, ActiveHold),
  id: Ulid,
  since: Timestamp,
}).pipe(
  Schema.refine(
    (suspension): suspension is typeof suspension => {
      const entries = Object.entries(suspension.holds);
      return (
        entries.length > 0 &&
        entries.every(
          ([slot, hold]) => slot === holdSlot(standingSource(hold.placedBy), hold.key),
        ) &&
        suspension.haltMode === haltMode(Object.values(suspension.holds))
      );
    },
    {
      identifier: "OrganizationSuspensionHolds",
      message:
        "A suspension holds at least one hold, each keyed by its source and key, and the halt mode its holds derive.",
    },
  ),
);
export type OrganizationSuspension = typeof OrganizationSuspension.Type;

export const ModelSpendCeiling = Schema.Union([
  Schema.Literal("unlimited"),
  Schema.Struct({ monthlyUsdMicros: NonNegativeSafeInteger }),
]);
export type ModelSpendCeiling = typeof ModelSpendCeiling.Type;

function grantedLimit(name: TenantLimitName) {
  const { maximum, minimum } = TENANT_LIMIT_DEFINITIONS[name];
  return Schema.optional(
    Schema.Number.pipe(
      Schema.check(
        Schema.isInt(),
        Schema.isGreaterThanOrEqualTo(minimum),
        Schema.isLessThanOrEqualTo(maximum),
      ),
    ),
  );
}

export const GrantedTenantLimits = Schema.Struct({
  activeSandboxes: grantedLimit("activeSandboxes"),
  apiRequestBurst: grantedLimit("apiRequestBurst"),
  apiRequestsPerSecond: grantedLimit("apiRequestsPerSecond"),
  concurrentRuns: grantedLimit("concurrentRuns"),
});
export type GrantedTenantLimits = typeof GrantedTenantLimits.Type;

/** Features a grant turns on or off; mirrors the public contract's `PLAN_FEATURES`. */
export const PLAN_FEATURE_NAMES = ["scim", "sso"] as const;
export type PlanFeatureName = (typeof PLAN_FEATURE_NAMES)[number];

export const GrantedPlanFeatures = Schema.Struct({
  scim: Schema.optional(Schema.Boolean),
  sso: Schema.optional(Schema.Boolean),
});
export type GrantedPlanFeatures = typeof GrantedPlanFeatures.Type;

/** What one source asserts. An absent field leaves the decision to the next source. */
export const EntitlementGrant = Schema.Struct({
  features: Schema.optional(GrantedPlanFeatures),
  operatorFundedModelSpendCeiling: Schema.optional(ModelSpendCeiling),
  tenantLimits: Schema.optional(GrantedTenantLimits),
});
export type EntitlementGrant = typeof EntitlementGrant.Type;

const grantFields = { entitlements: EntitlementGrant, grantedAt: Timestamp } as const;

export const StandingGrants = Schema.Struct({
  operator: Schema.optional(Schema.Struct({ ...grantFields, grantedBy: OperatorActor })),
  service: Schema.optional(Schema.Struct({ ...grantFields, grantedBy: ServiceActor })),
});
export type StandingGrants = typeof StandingGrants.Type;

/** A data boundary narrower than the open default; named by the agreement it serves. */
export const DataBoundaryProfile = Schema.Literals(["phi"]);
export type DataBoundaryProfile = typeof DataBoundaryProfile.Type;

/** Set and cleared only by an operator, so a service-set boundary is unrepresentable. */
export const OrganizationDataBoundary = Schema.Struct({
  /** The agreement reference; never shown to organization members. */
  operatorNote: StandingText,
  profile: DataBoundaryProfile,
  setAt: Timestamp,
  setBy: OperatorActor,
});
export type OrganizationDataBoundary = typeof OrganizationDataBoundary.Type;

export const OrganizationStandingRecord = makeRecordSchema("organization-standing", {
  ...mutableResourceFields,
  dataBoundary: Schema.optional(OrganizationDataBoundary),
  grants: StandingGrants,
  organizationId: Ulid,
  suspension: Schema.optional(OrganizationSuspension),
});
export type OrganizationStandingRecord = typeof OrganizationStandingRecord.Type;
export type OrganizationStanding = OrganizationStandingRecord["data"];

export const StandingChange = Schema.Union([
  Schema.Struct({ hold: ActiveHold, kind: Schema.Literal("hold-placed") }),
  Schema.Struct({
    hold: ActiveHold,
    kind: Schema.Literal("hold-released"),
    releaseNote: Schema.optional(StandingText),
  }),
  Schema.Struct({ entitlements: EntitlementGrant, kind: Schema.Literal("grant-set") }),
  Schema.Struct({ kind: Schema.Literal("grant-cleared") }),
  Schema.Struct({
    dataBoundary: OrganizationDataBoundary,
    kind: Schema.Literal("data-boundary-set"),
  }),
  Schema.Struct({
    kind: Schema.Literal("data-boundary-cleared"),
    operatorNote: StandingText,
    profile: DataBoundaryProfile,
  }),
]);
export type StandingChange = typeof StandingChange.Type;

/** Append-only: one record per standing version, written with that version. */
export const OrganizationStandingChangeRecord = makeRecordSchema("organization-standing-change", {
  actor: StandingActor,
  change: StandingChange,
  occurredAt: Timestamp,
  organizationId: Ulid,
  standingVersion: NonNegativeSafeInteger.pipe(Schema.check(Schema.isGreaterThanOrEqualTo(1))),
  state: Schema.Literals(["active", "suspended"]),
});
export type OrganizationStandingChangeRecord = typeof OrganizationStandingChangeRecord.Type;

/**
 * Create-only claim that an organization's operator-funded spend reached its ceiling in `month`.
 * It is written in the same transaction as the one `organization.operator-funded-spend-exhausted`
 * event, whose aggregate is `id`, so the event fires at most once per organization and month.
 */
export const OperatorFundedSpendExhaustionRecord = makeRecordSchema(
  "operator-funded-spend-exhaustion",
  {
    ceilingUsdMicros: NonNegativeSafeInteger,
    exhaustedAt: Timestamp,
    id: Ulid,
    month: SpendMonth,
    operatorFundedUsdMicros: NonNegativeSafeInteger,
    organizationId: Ulid,
  },
);
export type OperatorFundedSpendExhaustionRecord = typeof OperatorFundedSpendExhaustionRecord.Type;

export const EgressAllowlistEntryData = Schema.Struct({
  note: Schema.optionalKey(Schema.String),
  origin: Schema.String,
});

/**
 * Origins an organization admin lets public-egress tools reach without approval inside a data
 * boundary. One per organization; a missing record is an empty list.
 */
export const OrganizationEgressAllowlistRecord = makeRecordSchema("organization-egress-allowlist", {
  ...mutableResourceFields,
  entries: Schema.Array(EgressAllowlistEntryData).pipe(
    Schema.refine(
      (entries): entries is typeof entries => egressAllowlistIssues(entries).length === 0,
      {
        identifier: "EgressAllowlistEntries",
        message: `Expected at most ${EGRESS_ALLOWLIST_MAX_ENTRIES} unique normalized https origins with notes of at most ${EGRESS_ALLOWLIST_NOTE_MAX_LENGTH} characters.`,
      },
    ),
  ),
  organizationId: Ulid,
  updatedByPrincipalId: Ulid,
});
export type OrganizationEgressAllowlistRecord = typeof OrganizationEgressAllowlistRecord.Type;

export const ORGANIZATION_STANDING_RECORD_SCHEMAS = {
  "operator-funded-spend-exhaustion": OperatorFundedSpendExhaustionRecord,
  "organization-egress-allowlist": OrganizationEgressAllowlistRecord,
  "organization-standing": OrganizationStandingRecord,
  "organization-standing-change": OrganizationStandingChangeRecord,
} as const;
