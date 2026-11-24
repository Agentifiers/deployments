import clsx from "clsx";
import { useMemo } from "react";
import { manifestDiff, type DiffLine } from "../../agents/manifest-diff.ts";
import { Badge } from "@/components/ui/badge";
import { Text } from "@/components/ui/text";

const LINE_STYLES: Readonly<Record<DiffLine["kind"], string>> = {
  added: "bg-green-50 text-green-900 dark:bg-green-500/10 dark:text-green-200",
  context: "text-muted-foreground",
  removed: "bg-red-50 text-red-900 dark:bg-red-500/10 dark:text-red-200",
};
const HIGHLIGHT_STYLES: Readonly<Record<DiffLine["kind"], string>> = {
  added: "rounded-sm bg-green-200 dark:bg-green-500/30",
  context: "",
  removed: "rounded-sm bg-red-200 dark:bg-red-500/30",
};
const MARKERS: Readonly<Record<DiffLine["kind"], string>> = {
  added: "+",
  context: " ",
  removed: "-",
};

function LineText({ line }: Readonly<{ line: DiffLine }>) {
  if (!line.highlight) return <>{line.text}</>;
  const { end, start } = line.highlight;
  return (
    <>
      {line.text.slice(0, start)}
      <mark className={HIGHLIGHT_STYLES[line.kind]}>{line.text.slice(start, end)}</mark>
      {line.text.slice(end)}
    </>
  );
}

/**
 * Unified diff of two manifests over canonical JSON, with old and new line numbers and the
 * changed part of each edited line marked.
 */
export function ManifestDiffView({
  baseline,
  baselineLabel,
  candidate,
  candidateLabel,
}: Readonly<{
  baseline: unknown;
  baselineLabel: string;
  candidate: unknown;
  candidateLabel: string;
}>) {
  const diff = useMemo(() => manifestDiff(baseline, candidate), [baseline, candidate]);
  if (diff.identical) {
    return (
      <Text>
        {baselineLabel} and {candidateLabel} have identical manifests.
      </Text>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge color="red">−{diff.removed}</Badge>
        <Badge color="green">+{diff.added}</Badge>
        <Text>
          lines from {baselineLabel} to {candidateLabel}
        </Text>
      </div>
      <div
        aria-label={`Manifest changes from ${baselineLabel} to ${candidateLabel}`}
        className="overflow-hidden rounded-lg border border-border font-mono text-xs/5"
        role="table"
      >
        {diff.hunks.map((hunk) => (
          <div key={`${hunk.oldStart}:${hunk.newStart}`} role="rowgroup">
            <div
              className="border-y border-border/60 bg-muted px-3 py-1 text-muted-foreground first:border-t-0"
              role="row"
            >
              <span role="cell">
                @@ line {hunk.oldStart} → {hunk.newStart} @@
              </span>
            </div>
            {hunk.lines.map((line) => (
              <div
                className={clsx("grid grid-cols-[3rem_3rem_1.25rem_1fr]", LINE_STYLES[line.kind])}
                key={`${line.kind}:${line.oldNumber ?? ""}:${line.newNumber ?? ""}`}
                role="row"
              >
                <span className="pr-2 text-right text-muted-foreground select-none" role="cell">
                  {line.oldNumber ?? ""}
                </span>
                <span className="pr-2 text-right text-muted-foreground select-none" role="cell">
                  {line.newNumber ?? ""}
                </span>
                <span aria-hidden className="select-none">
                  {MARKERS[line.kind]}
                </span>
                <span className="pr-3 wrap-anywhere whitespace-pre-wrap" role="cell">
                  <LineText line={line} />
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
