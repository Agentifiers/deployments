import { useSuspenseQuery } from "@tanstack/react-query";
import { percentUsed } from "../../budgets/budget-amount.ts";
import {
  organizationLimitsQuery,
  organizationSpendQuery,
} from "../../data/organization-account-queries.ts";
import { formatExact, formatUsdMicros } from "../../observability/format.ts";
import type {
  OrganizationLimits,
  OrganizationSpend,
} from "../../server/organization-account-data.ts";
import { StatTile, Timestamp } from "../observability/panels.tsx";
import { Badge } from "@/components/ui/badge";
import { Callout, CalloutDescription, CalloutTitle } from "@/components/ui/callout";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { INSTALL_COPY, type InstallCopy } from "../../edition.ts";

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC", year: "numeric" });

const LIMITS: readonly { readonly name: keyof OrganizationLimits; readonly label: string }[] = [
  { label: "Concurrent runs", name: "concurrentRuns" },
  { label: "Active sandboxes", name: "activeSandboxes" },
  { label: "API requests per second", name: "apiRequestsPerSecond" },
  { label: "API request burst", name: "apiRequestBurst" },
];

/** The plan's limits come from a machine service's grant; only the operator's grant is custom. */
const SOURCE_BADGES = {
  default: { color: "zinc", label: "Default" },
  override: { color: "blue", label: "Custom" },
  plan: { color: "green", label: "Plan" },
} as const satisfies Record<
  OrganizationLimits[keyof OrganizationLimits]["source"],
  { readonly color: string; readonly label: string }
>;

/** The API reports today's ceiling for every month, so a past month names it as the current one. */
function ceilingDetail(spend: OrganizationSpend, current: boolean): string {
  const ceiling = spend.operatorFundedModelSpendCeiling;
  if (ceiling === "unlimited") return current ? "No monthly ceiling" : "No monthly ceiling now";
  if (ceiling.monthlyUsdMicros === 0)
    return "No monthly allowance, so model calls need an organization key";
  return `${percentUsed(spend.operatorFundedUsdMicros, ceiling.monthlyUsdMicros)}% of the ${current ? "" : "current "}${formatUsdMicros(ceiling.monthlyUsdMicros)} monthly ceiling`;
}

/** `month` undefined reads the current month to date. */
export function OrganizationSpendSection({
  copy = INSTALL_COPY["self-hosted"],
  month,
  organizationId,
}: Readonly<{ copy?: InstallCopy; month?: string | undefined; organizationId: string }>) {
  const { data: spend } = useSuspenseQuery(organizationSpendQuery(organizationId, month));
  const current = month === undefined;
  const ceiling = spend.operatorFundedModelSpendCeiling;
  const exhausted =
    ceiling !== "unlimited" &&
    ceiling.monthlyUsdMicros > 0 &&
    spend.operatorFundedUsdMicros >= ceiling.monthlyUsdMicros;
  return (
    <div className="flex flex-col gap-4">
      <Text>
        {MONTH.format(new Date(spend.periodStart))}
        {current ? " to date" : ""}, as of <Timestamp value={spend.asOf} />.
      </Text>
      {exhausted && current ? (
        <Callout variant="warning">
          <CalloutTitle>The monthly ceiling is reached</CalloutTitle>
          <CalloutDescription>
            Spend paid by {copy.operatorFundedPayer} has reached this month's ceiling. Model calls
            on the organization's model keys are not counted against it.
          </CalloutDescription>
        </Callout>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
          detail={ceilingDetail(spend, current)}
          label={copy.operatorFundedLabel}
          value={formatUsdMicros(spend.operatorFundedUsdMicros)}
        />
        <StatTile
          detail="Model calls on the organization's keys, at catalog prices"
          label="Paid with organization keys"
          value={formatUsdMicros(spend.organizationFundedUsdMicros)}
        />
        <StatTile label="Total" value={formatUsdMicros(spend.totalUsdMicros)} />
      </div>
    </div>
  );
}

export function OrganizationLimitsSection({
  organizationId,
}: Readonly<{ organizationId: string }>) {
  const { data: limits } = useSuspenseQuery(organizationLimitsQuery(organizationId));
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Limit</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead>Source</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {LIMITS.map(({ label, name }) => (
          <TableRow key={name}>
            <TableCell>{label}</TableCell>
            <TableCell className="text-right tabular-nums">
              {formatExact(limits[name].value)}
            </TableCell>
            <TableCell>
              <Badge color={SOURCE_BADGES[limits[name].source].color}>
                {SOURCE_BADGES[limits[name].source].label}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
