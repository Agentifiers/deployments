import {
  egressAllowlistIssues,
  egressNoteProblem,
  egressOriginProblem,
} from "@deployments-ai/db/egress-allowlist-rules";

export interface AllowlistRow {
  readonly origin: string;
  /** Blank means no note. */
  readonly note: string;
}

export interface AllowlistEntry {
  readonly origin: string;
  readonly note?: string;
}

export function rowsOf(entries: readonly AllowlistEntry[]): readonly AllowlistRow[] {
  return entries.map(({ note, origin }) => ({ note: note ?? "", origin }));
}

export function entriesOf(rows: readonly AllowlistRow[]): readonly AllowlistEntry[] {
  return rows.map(({ note, origin }) => (note === "" ? { origin } : { note, origin }));
}

/** Why the origin and note in the add form cannot join `rows`; undefined when they can. */
export function candidateProblem(
  rows: readonly AllowlistRow[],
  candidate: AllowlistRow,
): { readonly field: "note" | "origin"; readonly message: string } | undefined {
  const origin = egressOriginProblem(candidate.origin);
  if (origin) return { field: "origin", message: origin };
  if (rows.some((row) => row.origin === candidate.origin)) {
    return { field: "origin", message: `${candidate.origin} is already listed.` };
  }
  const note = candidate.note === "" ? undefined : egressNoteProblem(candidate.note);
  if (note) return { field: "note", message: note };
  return egressAllowlistIssues(entriesOf([...rows, candidate])).length > 0
    ? { field: "origin", message: "The allowlist is full." }
    : undefined;
}

/** Origins the save adds and removes, and whether any note changed. */
export function allowlistChange(saved: readonly AllowlistEntry[], rows: readonly AllowlistRow[]) {
  const before = new Map(saved.map((entry) => [entry.origin, entry.note ?? ""]));
  const after = new Map(rows.map((row) => [row.origin, row.note]));
  return {
    added: [...after.keys()].filter((origin) => !before.has(origin)),
    notesChanged: [...after].some(
      ([origin, note]) => before.has(origin) && before.get(origin) !== note,
    ),
    removed: [...before.keys()].filter((origin) => !after.has(origin)),
  };
}
