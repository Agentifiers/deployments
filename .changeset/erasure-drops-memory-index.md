---
"@deployments-ai/sdk": patch
"@deployments-ai/cli": patch
---

Tenant erasure (`POST /v1/organizations/:id/erasures`, CLI `deployments governance erase`) now deletes the organization's own memory search index when the organization alone owns it, and removes the search catalog records that existed only for that index. A shared memory index is purged as before. A retried erasure converges whether or not the index is already gone.
