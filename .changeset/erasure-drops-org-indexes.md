---
"@deployments-ai/sdk": patch
"@deployments-ai/cli": patch
---

Tenant erasure (`POST /v1/organizations/:id/erasures`, CLI `deployments governance erase`) now deletes the organization's own Brain search index once it has verified that the index holds none of the organization's documents. Erasing one Brain keeps the index. A retried erasure that finds the index already gone treats it as purged.
