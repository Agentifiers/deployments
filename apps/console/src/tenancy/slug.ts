import { Slug } from "@deployments-ai/api-contract/primitives";
import { Schema } from "effect";

const MAX_SLUG_LENGTH = 63;

/** Whether the API accepts `value` as an organization, project, or environment slug. */
export const isSlug: (value: string) => boolean = Schema.is(Slug);

/**
 * The slug a create dialog proposes for a display name. The API stores whatever slug it derives
 * without checking it, so the console always sends one that passes `isSlug`; a name without
 * letters or digits yields `""`, which the dialog rejects.
 */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/u, "");
}
