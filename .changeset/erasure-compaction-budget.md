---
"@deployments-ai/sdk": patch
"@deployments-ai/cli": patch
---

Tenant erasure (`POST /v1/organizations/:id/erasures`, CLI `deployments governance erase`) of an organization with a large memory search history now finishes in fewer background runs. Its memory search bookkeeping cleanup keeps making progress while the memory search domain is unreachable, and the purge of the search index starts once that cleanup finishes. Until then `erasure-status` reports `pending` with `memory_search_purge_pending`.

Because the purge now starts after that cleanup, the receipt's `backupErasureEligibleAt` can read later than before. A cleanup error now stops the run before the purge starts, and a later run retries both.
