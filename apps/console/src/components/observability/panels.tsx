import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const SOURCES = {
  analytics: {
    color: "zinc",
    explanation: "Figures from observability analytics (finalized traces), not the usage ledger.",
    label: "Analytics",
    title: "Observability analytics (finalized traces), not the usage ledger",
  },
  ledger: {
    color: "indigo",
    explanation:
      "Figures from the usage ledger (metered usage and cost), not observability analytics.",
    label: "Ledger",
  },
} as const;

/**
 * Every observability figure comes from the hot plane's trace and model-invocation facts, never
 * the usage ledger; the badge keeps the two sources apart wherever numbers appear. Prefer
 * `SourceNote` once per page or section, whose explanation is visible without hovering.
 */
export function AnalyticsBadge() {
  return (
    <Badge color={SOURCES.analytics.color} title={SOURCES.analytics.title}>
      {SOURCES.analytics.label}
    </Badge>
  );
}

/**
 * Names the source of every figure in a page or section once, with its explanation in view, so
 * the cards and charts beneath carry no badge of their own. Ledger figures (usage and cost) are
 * never summed with analytics figures (D7).
 */
export function SourceNote({ source }: Readonly<{ source: keyof typeof SOURCES }>) {
  const { color, explanation, label } = SOURCES[source];
  return (
    <span className="flex items-center gap-2 text-xs/5 text-muted-foreground">
      <Badge className="shrink-0" color={color}>
        {label}
      </Badge>
      <span>{explanation}</span>
    </span>
  );
}

export function ChartPanel({
  children,
  description,
  title,
}: Readonly<{ children: ReactNode; description?: ReactNode; title: ReactNode }>) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function StatTile({
  detail,
  label,
  title,
  value,
}: Readonly<{ detail?: ReactNode; label: ReactNode; title?: string; value: ReactNode }>) {
  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-1">
        <span className="text-sm/6 text-muted-foreground">{label}</span>
        <span className="text-2xl/8 font-semibold tabular-nums" title={title}>
          {value}
        </span>
        {detail ? <span className="text-xs/5 text-muted-foreground">{detail}</span> : null}
      </CardContent>
    </Card>
  );
}

/** `dateStyle`/`timeStyle` reject `timeZoneName`, so the fields are spelled out. */
export const TIMESTAMP_FORMAT: Intl.DateTimeFormatOptions = {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  timeZoneName: "short",
  year: "numeric",
};

/**
 * Local time with its zone named (`Nov 15, 2026, 4:00 AM PST`) and the UTC instant in the
 * tooltip; the server renders in UTC, the browser locally.
 */
export function Timestamp({ value }: Readonly<{ value: string }>) {
  return (
    <time dateTime={value} suppressHydrationWarning title={value}>
      {new Date(value).toLocaleString(undefined, TIMESTAMP_FORMAT)}
    </time>
  );
}
