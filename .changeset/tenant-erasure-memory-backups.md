---
"@agentifiers/deployments-cli": minor
"@agentifiers/deployments-sdk": minor
---

Tenant erasure completes once the memory search index no longer holds the organization's data, instead of staying `pending` for 14 days and 1 hour while memory search backups expire. The organization is erased as soon as the other erasure steps finish. A completed erasure reports when those backups expire in the new optional `summary.memorySearch.backupsExpireBy` field of `TenantErasureSummary`. Erasures that completed before this change have no `memorySearch` field. While the memory search purge tasks run, the operation stays `pending` with the error code `memory_search_purge_pending`, which replaces `memory_search_backup_erasure_pending`.
