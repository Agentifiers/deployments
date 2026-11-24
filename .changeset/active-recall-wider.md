---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Active recall returns more memory. `activeMemoryRecall` (`POST /v1/memory/active-recall`, CLI `deployments memory active-recall`) without `topK` now returns up to 32 memories instead of 10, within a 4,000-token budget instead of 1,200. When every memory the run can read fits in 32 memories and 7,000 tokens, recall returns all of them, oldest first, with ranks renumbered in that order and the original scores kept. A memory policy can lower that cap with `memoryRetrieval.fullContextTokenCap`, and 0 turns it off. The cap never rises above 7,000 tokens, because the agent prompt holds about that much memory text, and it never applies to memory search. A policy that already sets `contextTokenBudget` keeps ranked recall unless it also sets the cap. An explicit `topK` still limits the result count, and a whole set never exceeds 32 memories, even when `topK` is higher. Whole-set recall drops duplicates as ranked recall does, keeps the oldest copy, and counts the rest in the attempt's `duplicateCount`. Each recall attempt records its `selectionMode`, `whole-set` or `ranked`.
