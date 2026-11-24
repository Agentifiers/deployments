import {
  Ulid,
  type EffectiveStanding,
  type HoldState,
  type OrganizationStandingRepository,
} from "@deployments-ai/db";
import type {
  OrganizationRequestLimiter,
  RequestLimited,
  TenantLimits,
} from "@deployments-ai/tenant-limits";
import { Option, Schema } from "effect";
import {
  decideActivity,
  type ApiActivity,
  type OrganizationActivity,
  type StandingDecision,
} from "./activity-policy.ts";

export type GateDecision = StandingDecision | RequestLimited;

export interface OrganizationGate {
  /**
   * Decides an API request from standing cached for five seconds, then charges the organization's
   * request rate under that standing's effective limits. A failed standing read admits on the last
   * standing this process saw, or as active on `defaultLimits` when it saw none, and emits
   * `StandingUnavailable`.
   */
  readonly admit: (organizationId: string, activity: ApiActivity) => Promise<GateDecision>;
}

type StandingReader = Pick<OrganizationStandingRepository, "read">;

const decodeUlid = Schema.decodeUnknownOption(Ulid);
const STANDING_TTL_MS = 5_000;
const MAX_CACHED_ORGANIZATIONS = 10_000;

interface CachedStanding {
  readonly loadedAt: number;
  readonly standing: EffectiveStanding;
}

export function createOrganizationGate(input: {
  /** The install's default tenant limits, enforced when no standing is available. */
  readonly defaultLimits: TenantLimits;
  readonly limiter: OrganizationRequestLimiter;
  readonly now?: () => number;
  readonly service: string;
  readonly standing: StandingReader;
  readonly writeMetric?: (line: string) => void;
}): OrganizationGate {
  const now = input.now ?? Date.now;
  const writeMetric = input.writeMetric ?? ((line) => process.stdout.write(`${line}\n`));
  const cache = new Map<Ulid, CachedStanding>();

  const standingFor = async (organizationId: Ulid) => {
    const cached = cache.get(organizationId);
    const readAt = now();
    if (cached && readAt - cached.loadedAt < STANDING_TTL_MS) return cached.standing;
    try {
      const standing = await input.standing.read(organizationId);
      cache.delete(organizationId);
      cache.set(organizationId, { loadedAt: readAt, standing });
      if (cache.size > MAX_CACHED_ORGANIZATIONS) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return standing;
    } catch (cause) {
      writeMetric(
        JSON.stringify({
          _aws: {
            CloudWatchMetrics: [
              {
                Dimensions: [["Service"], []],
                Metrics: [{ Name: "StandingUnavailable", Unit: "Count" }],
                Namespace: "DeploymentsAi/OrganizationAdmission",
              },
            ],
            Timestamp: readAt,
          },
          Service: input.service,
          StandingUnavailable: 1,
          errorType: cause instanceof Error ? cause.name : "UnknownError",
          organizationId,
        }),
      );
      return cached?.standing;
    }
  };

  return {
    admit: async (organizationId, activity) => {
      const id = Option.getOrUndefined(decodeUlid(organizationId));
      const standing = id ? await standingFor(id) : undefined;
      if (standing) {
        const decision = decideActivity(standing, activity);
        if (decision.kind === "suspended") return decision;
      }
      return input.limiter.admit(
        organizationId,
        standing?.entitlements.tenantLimits ?? input.defaultLimits,
      );
    },
  };
}

/**
 * Reads standing strongly consistently, without a cache, and lets read errors propagate. For run
 * admission and token issue, where admitting on stale standing would start work a hold forbids.
 * `standing` may be the standing repository, or an `OrganizationHoldReader` when the caller needs
 * holds alone.
 */
export async function admitConsistently<Standing extends HoldState>(input: {
  readonly activity: OrganizationActivity;
  readonly organizationId: Ulid;
  readonly standing: {
    readonly read: (
      organizationId: Ulid,
      options: { readonly consistent: true },
    ) => Promise<Standing>;
  };
}): Promise<{ readonly decision: StandingDecision; readonly standing: Standing }> {
  const standing = await input.standing.read(input.organizationId, { consistent: true });
  return { decision: decideActivity(standing, input.activity), standing };
}
