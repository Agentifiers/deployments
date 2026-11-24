import {
  ClearSystemOrganizationDataBoundaryRequest,
  PlaceSystemOrganizationHoldRequest,
  ReleaseSystemOrganizationHoldRequest,
  ReplaceSystemOrganizationEntitlementsRequest,
  SetSystemOrganizationDataBoundaryRequest,
  type ListSystemOrganizationStandingHistoryResponse,
  type SystemOrganizationStandingChangeResponse,
  type SystemOrganizationStandingResponse,
} from "@deployments-ai/api-contract/system";
import {
  ALL_FEATURES_ENABLED,
  HoldKey,
  standingSource,
  Ulid,
  type ActiveHold,
  type InstallDefaults,
  type OrganizationEgressAllowlistReader,
  type OrganizationStandingChangeRecord,
  type OrganizationStandingRepository,
  type StandingActor,
  type StandingOutcome,
} from "@deployments-ai/db";
import { Schema } from "effect";
import { SystemOperatorProblem, parseBody } from "./service.ts";

const DEFAULT_HISTORY_PAGE = 50;
const strict = { onExcessProperty: "error" } as const;
const decodeUlid = Schema.decodeUnknownSync(Ulid);
const decodeHoldKey = Schema.decodeUnknownSync(HoldKey);
const decodePlaceHold = Schema.decodeUnknownSync(PlaceSystemOrganizationHoldRequest, strict);
const decodeReleaseHold = Schema.decodeUnknownSync(ReleaseSystemOrganizationHoldRequest, strict);
const decodeEntitlements = Schema.decodeUnknownSync(
  ReplaceSystemOrganizationEntitlementsRequest,
  strict,
);
const decodeSetDataBoundary = Schema.decodeUnknownSync(
  SetSystemOrganizationDataBoundaryRequest,
  strict,
);
const decodeClearDataBoundary = Schema.decodeUnknownSync(
  ClearSystemOrganizationDataBoundaryRequest,
  strict,
);

type StandingView = typeof SystemOrganizationStandingResponse.Encoded;
type StandingChangeView = typeof SystemOrganizationStandingChangeResponse.Encoded;

interface StandingWrite {
  /** The authenticated caller; the platform derives the source it writes as from it. */
  readonly actor: StandingActor;
  readonly organizationId: string;
}

export interface SystemOrganizationStanding {
  readonly read: (organizationId: string) => Promise<StandingView>;
  readonly history: (input: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly organizationId: string;
  }) => Promise<typeof ListSystemOrganizationStandingHistoryResponse.Encoded>;
  readonly placeHold: (
    input: StandingWrite & { readonly body: unknown; readonly holdKey: string },
  ) => Promise<StandingChangeView>;
  readonly releaseHold: (
    input: StandingWrite & { readonly body: unknown; readonly holdKey: string },
  ) => Promise<StandingChangeView>;
  readonly replaceEntitlements: (
    input: StandingWrite & { readonly body: unknown },
  ) => Promise<StandingChangeView>;
  readonly clearEntitlements: (input: StandingWrite) => Promise<StandingChangeView>;
  readonly setDataBoundary: (
    input: StandingWrite & { readonly body: unknown },
  ) => Promise<StandingChangeView>;
  readonly clearDataBoundary: (
    input: StandingWrite & { readonly body: unknown },
  ) => Promise<StandingChangeView>;
}

function holdView(hold: ActiveHold) {
  return {
    customerMessage: hold.customerMessage,
    key: hold.key,
    operatorNote: hold.operatorNote ?? null,
    placedAt: hold.placedAt,
    placedBy: hold.placedBy,
    reason: hold.reason,
    source: standingSource(hold.placedBy),
  };
}

function changeView({ change, ...item }: OrganizationStandingChangeRecord["data"]) {
  const viewed = (() => {
    switch (change.kind) {
      case "hold-placed":
        return { hold: holdView(change.hold), kind: change.kind };
      case "hold-released":
        return {
          hold: holdView(change.hold),
          kind: change.kind,
          releaseNote: change.releaseNote ?? null,
        };
      case "grant-set":
        return { entitlements: change.entitlements, kind: change.kind };
      case "grant-cleared":
        return { kind: change.kind };
      case "data-boundary-set":
        return { dataBoundary: change.dataBoundary, kind: change.kind };
      case "data-boundary-cleared":
        return { kind: change.kind, operatorNote: change.operatorNote, profile: change.profile };
    }
  })();
  return {
    actor: item.actor,
    change: viewed,
    occurredAt: item.occurredAt,
    state: item.state,
    version: item.standingVersion,
  };
}

function historyCursor(cursor: string | undefined) {
  if (cursor === undefined) return {};
  if (!/^[1-9]\d{0,15}$/u.test(cursor)) {
    throw new SystemOperatorProblem(
      400,
      "invalid_cursor",
      "cursor must be a nextCursor this route returned.",
    );
  }
  return { before: Number(cursor) };
}

export function makeSystemOrganizationStanding(dependencies: {
  readonly egressAllowlist: OrganizationEgressAllowlistReader;
  readonly installDefaults: InstallDefaults;
  readonly standing: OrganizationStandingRepository;
}): SystemOrganizationStanding {
  const { egressAllowlist, installDefaults, standing: repository } = dependencies;

  async function view(organizationId: string, consistent: boolean) {
    const id = decodeUlid(organizationId);
    const [{ dataBoundary, grants, standing }, allowlist] = await Promise.all([
      repository.readWithGrants(id, { consistent }),
      egressAllowlist.read(id),
    ]);
    return {
      dataBoundary: dataBoundary ?? null,
      defaults: { ...installDefaults, features: ALL_FEATURES_ENABLED },
      effective: standing.entitlements,
      egressAllowlist: allowlist,
      grants: { operator: grants.operator ?? null, service: grants.service ?? null },
      holds: standing.state === "suspended" ? standing.holds.map(holdView) : [],
      organizationId,
      state: standing.state,
      suspendedAt: standing.state === "suspended" ? standing.suspendedAt : null,
      version: standing.version,
    };
  }

  async function settle(organizationId: string, outcome: StandingOutcome, owned: string) {
    if (outcome.kind === "refused") {
      throw new SystemOperatorProblem(
        409,
        "standing_owned_by_another_source",
        `${owned} belongs to ${outcome.owner}; only that source can change it.`,
        { owner: outcome.owner },
      );
    }
    return { changed: outcome.kind === "changed", standing: await view(organizationId, true) };
  }

  return {
    read: (organizationId) => view(organizationId, false),
    history: async ({ cursor, limit, organizationId }) => {
      const page = await repository.listHistory({
        ...historyCursor(cursor),
        limit: limit ?? DEFAULT_HISTORY_PAGE,
        organizationId: decodeUlid(organizationId),
      });
      return {
        items: page.items.map(changeView),
        nextCursor: page.before === undefined ? null : String(page.before),
      };
    },
    placeHold: async ({ actor, body, holdKey, organizationId }) => {
      const { customerMessage, operatorNote, reason } = parseBody(decodePlaceHold, body);
      const outcome = await repository.placeHold({
        actor,
        customerMessage,
        key: decodeHoldKey(holdKey),
        ...(operatorNote === undefined ? {} : { operatorNote }),
        organizationId: decodeUlid(organizationId),
        reason,
      });
      return settle(organizationId, outcome, `Hold ${holdKey}`);
    },
    releaseHold: async ({ actor, body, holdKey, organizationId }) => {
      const { releaseNote } = parseBody(decodeReleaseHold, body ?? {});
      const outcome = await repository.releaseHold({
        actor,
        key: decodeHoldKey(holdKey),
        organizationId: decodeUlid(organizationId),
        ...(releaseNote === undefined ? {} : { releaseNote }),
      });
      return settle(organizationId, outcome, `Hold ${holdKey}`);
    },
    replaceEntitlements: async ({ actor, body, organizationId }) => {
      const outcome = await repository.setGrant({
        actor,
        entitlements: parseBody(decodeEntitlements, body),
        organizationId: decodeUlid(organizationId),
      });
      return settle(organizationId, outcome, "The service grant");
    },
    clearEntitlements: async ({ actor, organizationId }) => {
      const outcome = await repository.clearGrant({
        actor,
        organizationId: decodeUlid(organizationId),
      });
      return settle(organizationId, outcome, "The service grant");
    },
    setDataBoundary: async ({ actor, body, organizationId }) => {
      const { operatorNote, profile } = parseBody(decodeSetDataBoundary, body);
      const outcome = await repository.setDataBoundary({
        actor,
        operatorNote,
        organizationId: decodeUlid(organizationId),
        profile,
      });
      return settle(organizationId, outcome, "The data boundary");
    },
    clearDataBoundary: async ({ actor, body, organizationId }) => {
      const { operatorNote } = parseBody(decodeClearDataBoundary, body);
      const outcome = await repository.clearDataBoundary({
        actor,
        operatorNote,
        organizationId: decodeUlid(organizationId),
      });
      return settle(organizationId, outcome, "The data boundary");
    },
  };
}
