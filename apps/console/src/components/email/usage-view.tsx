import { Download04Icon } from "@hugeicons/core-free-icons";
import { useMutation, useSuspenseInfiniteQuery, useSuspenseQuery } from "@tanstack/react-query";
import { useState } from "react";
import { inboxPagesQuery } from "../../data/agent-email-inbox-queries.ts";
import { exportUsageFn, usageSummaryQuery } from "../../data/agent-email-setup-queries.ts";
import {
  USAGE_BUCKETS,
  USAGE_FORMATS,
  USAGE_RANGES,
  type UsageBucket,
  type UsageFormat,
  type UsageRange,
} from "../../email/usage-state.ts";
import { formatExact } from "../../observability/format.ts";
import { oneOf } from "../../observability/range.ts";
import type { EnvironmentScope } from "../../scope.ts";
import { Button } from "@/components/ui/button";
import { Subheading } from "@/components/ui/heading";
import { NativeSelect } from "@/components/ui/native-select";
import { Text } from "@/components/ui/text";
import { SingleToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { downloadText } from "../download.ts";
import { Icon } from "../icon.tsx";
import { FilterSelect } from "../list-controls.tsx";
import { StatTile, Timestamp } from "../observability/panels.tsx";
import { describeProblem } from "../section-boundary.tsx";

const RANGE_LABELS: Readonly<Record<UsageRange, string>> = {
  "24h": "24 hours",
  "30d": "30 days",
  "7d": "7 days",
};

const bytes = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
  style: "unit",
  unit: "byte",
  unitDisplay: "narrow",
});

export function UsageView({
  inboxId,
  onChange,
  range,
  scope,
}: Readonly<{
  inboxId: string | undefined;
  onChange: (next: { readonly inbox?: string; readonly range?: UsageRange }) => void;
  range: UsageRange;
  scope: EnvironmentScope;
}>) {
  const { data: summary } = useSuspenseQuery(usageSummaryQuery(scope, range, inboxId));
  const { data: inboxPages } = useSuspenseInfiniteQuery(inboxPagesQuery(scope, undefined));
  const inboxes = inboxPages.pages.flatMap((page) => page.items);
  const select = (next: { readonly inbox?: string | undefined; readonly range?: UsageRange }) => {
    const nextRange = next.range ?? range;
    const nextInbox = "inbox" in next ? next.inbox : inboxId;
    onChange({
      ...(nextInbox === undefined ? {} : { inbox: nextInbox }),
      ...(nextRange === "30d" ? {} : { range: nextRange }),
    });
  };
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-center gap-3">
        <SingleToggleGroup
          aria-label="Usage range"
          onValueChange={(value) => {
            const next = oneOf(USAGE_RANGES, value);
            if (next) select({ range: next });
          }}
          size="sm"
          value={range}
        >
          {USAGE_RANGES.map((option) => (
            <ToggleGroupItem key={option} value={option}>
              {RANGE_LABELS[option]}
            </ToggleGroupItem>
          ))}
        </SingleToggleGroup>
        <FilterSelect
          label="Inbox"
          onChange={(inbox) => select({ inbox })}
          options={inboxes.map((inbox) => ({ label: inbox.address, value: inbox.id }))}
          value={inboxId}
        />
      </div>
      <Text>
        <Timestamp value={summary.from} /> to <Timestamp value={summary.to} />
      </Text>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Outbound messages" value={formatExact(summary.outboundMessages)} />
        <StatTile label="Inbound messages" value={formatExact(summary.inboundMessages)} />
        <StatTile
          label="Attachment bytes"
          title={formatExact(summary.attachmentBytes)}
          value={bytes.format(summary.attachmentBytes)}
        />
        <StatTile
          label="Stored bytes"
          title={formatExact(summary.storedBytes)}
          value={bytes.format(summary.storedBytes)}
        />
      </div>
      <UsageExport inboxId={inboxId} range={range} scope={scope} />
    </div>
  );
}

function UsageExport({
  inboxId,
  range,
  scope,
}: Readonly<{ inboxId: string | undefined; range: UsageRange; scope: EnvironmentScope }>) {
  const [bucket, setBucket] = useState<UsageBucket>("day");
  const [format, setFormat] = useState<UsageFormat>("csv");
  const exported = useMutation({
    mutationFn: () => exportUsageFn({ data: { bucket, format, inboxId, range, scope } }),
    onSuccess: (result) => {
      const name = `agent-email-usage-${result.from.slice(0, 10)}-${result.to.slice(0, 10)}-${result.bucket}`;
      if (result.format === "csv")
        downloadText(result.csv ?? "", `${name}.csv`, "text/csv;charset=utf-8");
      else downloadText(JSON.stringify(result.rows, null, 2), `${name}.json`, "application/json");
    },
  });
  return (
    <section className="flex flex-col gap-4">
      <Subheading>Export</Subheading>
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-40">
          <NativeSelect
            aria-label="Bucket"
            onChange={(event) => setBucket(oneOf(USAGE_BUCKETS, event.target.value) ?? "day")}
            value={bucket}
          >
            {USAGE_BUCKETS.map((option) => (
              <option key={option} value={option}>
                Per {option}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="w-32">
          <NativeSelect
            aria-label="Format"
            onChange={(event) => setFormat(oneOf(USAGE_FORMATS, event.target.value) ?? "csv")}
            value={format}
          >
            {USAGE_FORMATS.map((option) => (
              <option key={option} value={option}>
                {option.toUpperCase()}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button disabled={exported.isPending} onClick={() => exported.mutate()} variant="outline">
          <Icon icon={Download04Icon} />
          {exported.isPending ? "Exporting…" : "Download export"}
        </Button>
      </div>
      {exported.data ? <Text>Exported {formatExact(exported.data.rows.length)} rows.</Text> : null}
      {exported.error ? (
        <Text>{describeProblem(exported.error, "The export failed").title}</Text>
      ) : null}
    </section>
  );
}
