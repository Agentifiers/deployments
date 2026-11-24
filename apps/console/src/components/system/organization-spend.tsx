import { useSuspenseQuery } from "@tanstack/react-query";
import { systemSpendQuery } from "../../data/system-queries.ts";
import { useInstallCopy } from "../../edition.ts";
import { formatUsdMicros } from "../../observability/format.ts";
import { Field, Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { StatTile, Timestamp } from "../observability/panels.tsx";

const MONTH = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

/** The current UTC month as YYYY-MM, the latest month the spend route answers. */
export function currentMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** A month from the URL, or the current month when it is missing, malformed, or in the future. */
export function spendMonth(value: unknown, now = new Date()): string {
  const latest = currentMonth(now);
  return typeof value === "string" && MONTH.test(value) && value <= latest ? value : latest;
}

export function MonthPicker({
  month,
  onMonth,
}: Readonly<{ month: string; onMonth: (month: string) => void }>) {
  return (
    <Field className="w-48">
      <Label>Month (UTC)</Label>
      <Input
        max={currentMonth()}
        name="month"
        onChange={(event) => {
          if (MONTH.test(event.target.value)) onMonth(event.target.value);
        }}
        type="month"
        value={month}
      />
    </Field>
  );
}

export function OrganizationSpend({
  month,
  organizationId,
}: Readonly<{ month: string; organizationId: string }>) {
  const { data: spend } = useSuspenseQuery(systemSpendQuery(organizationId, month));
  const copy = useInstallCopy();
  return (
    <div className="flex flex-col gap-4">
      <Text>
        {spend.month}, as of <Timestamp value={spend.asOf} />.
      </Text>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile
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
