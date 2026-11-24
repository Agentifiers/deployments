import type { BrainSearchProviderHit } from "./search-provider.ts";

export function mergeBrainSearchRanks(
  dense: readonly BrainSearchProviderHit[],
  lexical: readonly BrainSearchProviderHit[],
  limit: number,
  exact: readonly BrainSearchProviderHit[] = [],
  entity: readonly BrainSearchProviderHit[] = [],
) {
  const scores = new Map<string, { hit: BrainSearchProviderHit; score: number }>();
  const add = (
    hits: readonly BrainSearchProviderHit[],
    kind: "dense" | "entity" | "exact" | "lexical",
  ) => {
    hits.forEach((hit, index) => {
      const existing = scores.get(hit.chunkId);
      const score = (existing?.score ?? 0) + 1 / (60 + index + 1);
      scores.set(hit.chunkId, {
        hit: {
          ...(existing?.hit ?? hit),
          ...(kind === "dense"
            ? { denseScore: hit.denseScore ?? 1 / (index + 1) }
            : kind === "lexical"
              ? { lexicalScore: hit.lexicalScore ?? 1 / (index + 1) }
              : kind === "exact"
                ? { exactScore: hit.exactScore ?? 1 / (index + 1) }
                : { entityScore: hit.entityScore ?? 1 / (index + 1) }),
        },
        score,
      });
    });
  };
  add(dense, "dense");
  add(lexical, "lexical");
  add(exact, "exact");
  add(entity, "entity");
  return [...scores.values()]
    .sort(
      (left, right) =>
        right.score - left.score || left.hit.chunkId.localeCompare(right.hit.chunkId),
    )
    .slice(0, limit)
    .map(({ hit }) => hit);
}
