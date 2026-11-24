import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { SCOPE_FIELDS, scopeKey, type EnvironmentScope } from "../scope.ts";
import { requireAccessToken } from "../server/session.ts";
import { loadAgentUsage, loadLedger, loadUsageBreakdown } from "../server/usage-data.ts";
import { parseUsageSelection, type UsagePeriod, type UsageSelection } from "../usage/selection.ts";
import { fields, requireIds } from "./server-input.ts";

/** Server functions accept arbitrary payloads: re-validate the scope and the selection. */
function selectionInput(input: unknown) {
  const value = fields(input);
  return {
    scope: requireIds(value.scope, SCOPE_FIELDS),
    selection: parseUsageSelection(fields(value.selection)),
  };
}

const fetchLedger = createServerFn({ method: "GET" })
  .validator(
    (input: {
      readonly definitionId?: string;
      readonly includeCosts: boolean;
      readonly period: UsagePeriod;
      readonly scope: EnvironmentScope;
    }) => {
      const value = fields(input);
      const { interval, range } = parseUsageSelection(fields(value.period));
      return {
        ...(value.definitionId === undefined
          ? {}
          : { definitionId: requireIds(value, ["definitionId"]).definitionId }),
        includeCosts: value.includeCosts === true,
        period: { interval, range },
        scope: requireIds(value.scope, SCOPE_FIELDS),
      };
    },
  )
  .handler(async ({ data }) =>
    loadLedger(
      await requireAccessToken(),
      data.scope,
      data.period,
      data.includeCosts,
      data.definitionId,
    ),
  );

const fetchUsageBreakdown = createServerFn({ method: "GET" })
  .validator((input: { readonly scope: EnvironmentScope; readonly selection: UsageSelection }) =>
    selectionInput(input),
  )
  .handler(async ({ data }) =>
    loadUsageBreakdown(await requireAccessToken(), data.scope, data.selection),
  );

const fetchAgentUsage = createServerFn({ method: "GET" })
  .validator(
    (input: {
      readonly definitionId: string;
      readonly period: UsagePeriod;
      readonly scope: EnvironmentScope;
    }) => {
      const value = fields(input);
      const { interval, range } = parseUsageSelection(fields(value.period));
      return {
        definitionId: requireIds(value, ["definitionId"]).definitionId,
        period: { interval, range },
        scope: requireIds(value.scope, SCOPE_FIELDS),
      };
    },
  )
  .handler(async ({ data }) =>
    loadAgentUsage(await requireAccessToken(), data.scope, data.definitionId, data.period),
  );

/**
 * The period's ledger series, of the environment or (with `definitionId`) of one agent's runs;
 * `includeCosts` follows `shell.access.getCostSummary`.
 */
export const ledgerUsageQuery = (
  scope: EnvironmentScope,
  period: UsagePeriod,
  includeCosts: boolean,
  definitionId?: string,
) =>
  queryOptions({
    queryFn: () =>
      fetchLedger({
        data: {
          ...(definitionId ? { definitionId } : {}),
          includeCosts,
          period: { interval: period.interval, range: period.range },
          scope,
        },
      }),
    queryKey: [
      "usage-ledger",
      ...scopeKey(scope),
      definitionId ?? null,
      period.range,
      period.interval,
      includeCosts,
    ],
  });

export const usageBreakdownQuery = (scope: EnvironmentScope, selection: UsageSelection) =>
  queryOptions({
    queryFn: () => fetchUsageBreakdown({ data: { scope, selection } }),
    queryKey: [
      "usage-breakdown",
      ...scopeKey(scope),
      selection.range,
      selection.interval,
      selection.groupBy,
    ],
  });

export const agentUsageQuery = (
  scope: EnvironmentScope,
  definitionId: string,
  period: UsagePeriod,
) =>
  queryOptions({
    queryFn: () =>
      fetchAgentUsage({
        data: { definitionId, period: { interval: period.interval, range: period.range }, scope },
      }),
    queryKey: ["agent-usage", ...scopeKey(scope), definitionId, period.range, period.interval],
  });
