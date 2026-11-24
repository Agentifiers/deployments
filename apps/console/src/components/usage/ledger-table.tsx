import { formatBucket, formatExact } from "../../observability/format.ts";
import type { MetricInterval } from "../../observability/range.ts";
import { Subheading } from "@/components/ui/heading";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Text } from "@/components/ui/text";
import { ledgerRows, seriesHeader, usdFixed } from "../../usage/export.ts";
import type { LedgerSeries, LedgerUsage } from "../../usage/ledger.ts";

const numberCell = "text-right tabular-nums";

/** Exact cell values: the CSV's numbers, with USD marked and counts grouped. */
function cell(series: LedgerSeries, value: number) {
  return series.kind === "cost" ? `$${usdFixed(value)}` : formatExact(value);
}

/**
 * The aggregated rows the CSV export carries: one row per bucket with recorded usage and a total
 * row, each series in its ledger unit (costs in USD to the micro-dollar).
 */
export function LedgerTable({
  interval,
  usage,
}: Readonly<{ interval: MetricInterval; usage: LedgerUsage }>) {
  const rows = ledgerRows(usage);
  return (
    <section className="flex flex-col gap-3">
      <Subheading>Aggregated rows</Subheading>
      <Text>
        Buckets without recorded usage are omitted. The export holds exactly these rows, with bucket
        starts in UTC.
      </Text>
      <Table dense>
        <TableHeader>
          <TableRow>
            <TableHead>Bucket</TableHead>
            {usage.series.map((series) => (
              <TableHead className={numberCell} key={series.id}>
                {seriesHeader(series)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.bucket}>
              <TableCell>
                <time dateTime={row.bucket} suppressHydrationWarning title={row.bucket}>
                  {formatBucket(row.bucket, interval, "full")}
                </time>
              </TableCell>
              {row.values.map((value, index) => (
                <TableCell className={numberCell} key={usage.series[index]!.id}>
                  {cell(usage.series[index]!, value)}
                </TableCell>
              ))}
            </TableRow>
          ))}
          <TableRow>
            <TableCell className="font-semibold">Total</TableCell>
            {usage.series.map((series) => (
              <TableCell className={`${numberCell} font-semibold`} key={series.id}>
                {cell(series, series.total)}
              </TableCell>
            ))}
          </TableRow>
        </TableBody>
      </Table>
    </section>
  );
}
