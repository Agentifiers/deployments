---
"@deployments-ai/sdk": patch
"@deployments-ai/cli": patch
---

Tenant erasure (`POST /v1/organizations/:id/erasures`, CLI `deployments governance erase`) now completes for an organization whose memory search index was already dropped. Before, `erasure-status` reported such an erasure as `pending` with `memory_search_purge_pending` indefinitely.
