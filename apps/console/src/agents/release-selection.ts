/** Search parameters of the Releases tab. */

/** Stands for the definition's current draft wherever a release ID is accepted. */
export const DRAFT = "draft";

const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/u;

export interface ReleaseSearch {
  /** Older side of the manifest diff: a release ID or `draft`. */
  readonly baseline?: string;
  /** Newer side of the manifest diff: a release ID or `draft`. */
  readonly candidate?: string;
  /** Release whose details are open. */
  readonly release?: string;
}

/** Keeps only well-formed values; anything else falls back to the defaults. */
export function parseReleaseSearch(search: Readonly<Record<string, unknown>>): ReleaseSearch {
  const parsed: { baseline?: string; candidate?: string; release?: string } = {};
  for (const key of ["baseline", "candidate", "release"] as const) {
    const value = search[key];
    if (typeof value !== "string") continue;
    if (ULID.test(value) || (key !== "release" && value === DRAFT)) parsed[key] = value;
  }
  return parsed;
}

/**
 * The two manifests to compare. Defaults to the latest release against the draft, which is what
 * publishing would change. A release that is not this agent's falls back to the default; without
 * releases there is nothing to compare.
 */
export function resolveComparison(
  releaseIds: readonly string[],
  search: ReleaseSearch,
): { readonly baseline: string; readonly candidate: string } | undefined {
  const latest = releaseIds[0];
  if (latest === undefined) return undefined;
  const known = (value: string | undefined) =>
    value === DRAFT || (value !== undefined && releaseIds.includes(value)) ? value : undefined;
  return {
    baseline: known(search.baseline) ?? latest,
    candidate: known(search.candidate) ?? DRAFT,
  };
}
