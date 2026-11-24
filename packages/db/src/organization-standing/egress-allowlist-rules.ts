import { normalizeEgressOrigin, type EgressAllowlistEntry } from "./egress-destinations.ts";

/**
 * The rules an organization's egress allowlist obeys, shared by the record schema, the API, and
 * the console form. Pure and free of AWS imports so the console can bundle it.
 */
export const EGRESS_ALLOWLIST_MAX_ENTRIES = 200;
export const EGRESS_ALLOWLIST_NOTE_MAX_LENGTH = 200;

export interface EgressAllowlistIssue {
  /** JSON pointer into `{ entries }`, such as `/entries/2/origin`. */
  readonly pointer: string;
  readonly message: string;
}

/** Why `origin` is not a normalized `https://host[:port]` origin; undefined when it is. */
export function egressOriginProblem(origin: string): string | undefined {
  if (origin.includes("*")) return "Wildcards are not allowed. List each origin.";
  let url: URL | undefined;
  try {
    url = new URL(origin.trim());
  } catch {
    url = undefined;
  }
  if (url?.protocol === "http:") return "Use https. Plain http is not allowed.";
  if (url && (url.username || url.password)) return "Remove the credentials from the origin.";
  const normalized = normalizeEgressOrigin(origin);
  if (!url || normalized === undefined) {
    return "Enter an https origin such as https://api.example.com.";
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    return "Enter only the origin, without a path, query, or fragment.";
  }
  return normalized === origin ? undefined : `Write it as ${normalized}.`;
}

export function egressNoteProblem(note: string): string | undefined {
  if (note.trim().length === 0) return "A note must not be blank. Leave it out instead.";
  return note.length > EGRESS_ALLOWLIST_NOTE_MAX_LENGTH
    ? `Keep the note to ${EGRESS_ALLOWLIST_NOTE_MAX_LENGTH} characters.`
    : undefined;
}

/** Every rule the entries break, in order; empty when the list is valid. */
export function egressAllowlistIssues(
  entries: readonly EgressAllowlistEntry[],
): readonly EgressAllowlistIssue[] {
  const issues: EgressAllowlistIssue[] = [];
  if (entries.length > EGRESS_ALLOWLIST_MAX_ENTRIES) {
    issues.push({
      message: `An allowlist holds at most ${EGRESS_ALLOWLIST_MAX_ENTRIES} origins.`,
      pointer: "/entries",
    });
  }
  const firstIndex = new Map<string, number>();
  entries.forEach((entry, index) => {
    const originProblem = egressOriginProblem(entry.origin);
    if (originProblem) {
      issues.push({ message: originProblem, pointer: `/entries/${index}/origin` });
    } else {
      const earlier = firstIndex.get(entry.origin);
      if (earlier === undefined) firstIndex.set(entry.origin, index);
      else {
        issues.push({
          message: `${entry.origin} is already entry ${earlier}.`,
          pointer: `/entries/${index}/origin`,
        });
      }
    }
    const noteProblem = entry.note === undefined ? undefined : egressNoteProblem(entry.note);
    if (noteProblem) issues.push({ message: noteProblem, pointer: `/entries/${index}/note` });
  });
  return issues;
}
