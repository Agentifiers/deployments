/**
 * Readable manifest diffs: both manifests are printed as canonical JSON (keys sorted by code
 * unit, as the platform does before hashing, two-space indent) and compared line by line.
 */

/** Edit distance beyond which the diff gives up on alignment and replaces the whole document. */
const MAX_EDIT_DISTANCE = 2_000;
const DEFAULT_CONTEXT_LINES = 3;

type DiffLineKind = "added" | "context" | "removed";

export interface DiffLine {
  /** For a changed line paired with its counterpart: the half-open range that differs. */
  readonly highlight?: { readonly end: number; readonly start: number };
  readonly kind: DiffLineKind;
  /** 1-based line number in the new document; absent for removed lines. */
  readonly newNumber?: number;
  /** 1-based line number in the old document; absent for added lines. */
  readonly oldNumber?: number;
  readonly text: string;
}

export interface DiffHunk {
  readonly lines: readonly DiffLine[];
  readonly newStart: number;
  readonly oldStart: number;
}

export interface ManifestDiff {
  readonly added: number;
  readonly hunks: readonly DiffHunk[];
  readonly identical: boolean;
  readonly removed: number;
}

/** Keys sort by UTF-16 code unit, like the platform's canonical JSON (not `localeCompare`). */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

/** Pretty-printed canonical JSON: equal manifests print identically regardless of key order. */
export function canonicalManifestJson(manifest: unknown): string {
  return JSON.stringify(canonicalValue(manifest), null, 2);
}

type Edit = { readonly kind: DiffLineKind; readonly newIndex: number; readonly oldIndex: number };

/**
 * Myers' shortest edit script over lines. Each step keeps only its diagonals' furthest reach
 * (2d + 1 entries), so memory grows with the square of the edit distance, which is capped.
 */
function shortestEditScript(before: readonly string[], after: readonly string[]) {
  const n = before.length;
  const m = after.length;
  const limit = Math.min(n + m, MAX_EDIT_DISTANCE);
  const trace: Int32Array[] = [];
  let previous = new Int32Array([0, 0, 0]);
  const reach = (row: Int32Array, d: number, k: number) => row[k + d] ?? 0;
  for (let d = 0; d <= limit; d += 1) {
    const row = new Int32Array(2 * d + 1);
    for (let k = -d; k <= d; k += 2) {
      const down =
        k === -d || (k !== d && reach(previous, d - 1, k - 1) < reach(previous, d - 1, k + 1));
      let x =
        d === 0 ? 0 : down ? reach(previous, d - 1, k + 1) : reach(previous, d - 1, k - 1) + 1;
      let y = x - k;
      while (x < n && y < m && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      row[k + d] = x;
      if (x >= n && y >= m) {
        trace.push(row);
        return trace;
      }
    }
    trace.push(row);
    previous = row;
  }
  return undefined;
}

function backtrack(trace: readonly Int32Array[], n: number, m: number): Edit[] {
  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const previous = trace[d - 1] ?? new Int32Array();
    const reach = (k: number) => previous[k + d - 1] ?? 0;
    const k = x - y;
    const down = k === -d || (k !== d && reach(k - 1) < reach(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = reach(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      edits.push({ kind: "context", newIndex: y, oldIndex: x });
    }
    if (down) edits.push({ kind: "added", newIndex: previousY, oldIndex: previousX });
    else edits.push({ kind: "removed", newIndex: previousY, oldIndex: previousX });
    x = previousX;
    y = previousY;
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    edits.push({ kind: "context", newIndex: y, oldIndex: x });
  }
  return edits.toReversed();
}

/** Every removed line, then every added line: the fallback when the documents barely align. */
function replaceAll(n: number, m: number): Edit[] {
  return [
    ...Array.from({ length: n }, (_, index) => ({
      kind: "removed" as const,
      newIndex: 0,
      oldIndex: index,
    })),
    ...Array.from({ length: m }, (_, index) => ({
      kind: "added" as const,
      newIndex: index,
      oldIndex: n,
    })),
  ];
}

/** The differing middle of two lines that share a prefix or suffix, else undefined. */
function changedRanges(before: string, after: string) {
  const shorter = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shorter && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shorter - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  if (prefix + suffix === 0) return undefined;
  return {
    after: { end: after.length - suffix, start: prefix },
    before: { end: before.length - suffix, start: prefix },
  };
}

/**
 * Pairs the removed and added lines of each change block in order and marks the part of each
 * pair that differs, so a one-word edit inside a long instruction string stands out.
 */
function highlightPairs(lines: DiffLine[]): DiffLine[] {
  const result = [...lines];
  let index = 0;
  while (index < result.length) {
    if (result[index]?.kind !== "removed") {
      index += 1;
      continue;
    }
    const removedStart = index;
    while (result[index]?.kind === "removed") index += 1;
    const addedStart = index;
    while (result[index]?.kind === "added") index += 1;
    const pairs = Math.min(addedStart - removedStart, index - addedStart);
    for (let offset = 0; offset < pairs; offset += 1) {
      const removed = result[removedStart + offset];
      const added = result[addedStart + offset];
      if (!removed || !added) continue;
      const ranges = changedRanges(removed.text, added.text);
      if (!ranges) continue;
      result[removedStart + offset] = { ...removed, highlight: ranges.before };
      result[addedStart + offset] = { ...added, highlight: ranges.after };
    }
  }
  return result;
}

/** Line diff of two texts, every line included. */
export function diffLines(before: string, after: string): DiffLine[] {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  const trace = shortestEditScript(oldLines, newLines);
  const edits = trace
    ? backtrack(trace, oldLines.length, newLines.length)
    : replaceAll(oldLines.length, newLines.length);
  return highlightPairs(
    edits.map((edit): DiffLine => {
      if (edit.kind === "added") {
        return { kind: "added", newNumber: edit.newIndex + 1, text: newLines[edit.newIndex] ?? "" };
      }
      if (edit.kind === "removed") {
        return {
          kind: "removed",
          oldNumber: edit.oldIndex + 1,
          text: oldLines[edit.oldIndex] ?? "",
        };
      }
      return {
        kind: "context",
        newNumber: edit.newIndex + 1,
        oldNumber: edit.oldIndex + 1,
        text: oldLines[edit.oldIndex] ?? "",
      };
    }),
  );
}

/** Groups changed lines with `context` unchanged lines around them; nearby groups merge. */
export function diffHunks(lines: readonly DiffLine[], context = DEFAULT_CONTEXT_LINES): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let start: number | undefined;
  let end = 0;
  const close = () => {
    if (start === undefined) return;
    const slice = lines.slice(start, end);
    const first = slice[0];
    hunks.push({
      lines: slice,
      newStart: first?.newNumber ?? slice.find((line) => line.newNumber)?.newNumber ?? 1,
      oldStart: first?.oldNumber ?? slice.find((line) => line.oldNumber)?.oldNumber ?? 1,
    });
    start = undefined;
  };
  lines.forEach((line, index) => {
    if (line.kind === "context") return;
    const from = Math.max(0, index - context);
    if (start !== undefined && from > end) close();
    start ??= from;
    end = Math.min(lines.length, index + context + 1);
  });
  close();
  return hunks;
}

/** Diff of two manifests as canonical JSON, grouped into hunks with three lines of context. */
export function manifestDiff(baseline: unknown, candidate: unknown): ManifestDiff {
  const before = canonicalManifestJson(baseline);
  const after = canonicalManifestJson(candidate);
  if (before === after) return { added: 0, hunks: [], identical: true, removed: 0 };
  const lines = diffLines(before, after);
  return {
    added: lines.filter((line) => line.kind === "added").length,
    hunks: diffHunks(lines),
    identical: false,
    removed: lines.filter((line) => line.kind === "removed").length,
  };
}
