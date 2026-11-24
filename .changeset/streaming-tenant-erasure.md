---
"@deployments-ai/sdk": patch
"@deployments-ai/cli": patch
---

Tenant erasure (`POST /v1/organizations/:id/erasures`, CLI `deployments governance erase`) no longer refuses an organization above 1,000,000 records or 512 MiB with `tenant_export_too_large`. A large organization now erases over several background runs, and between runs `erasure-status` reports the operation as `pending` with the error code `tenant_erasure_continuing`. Tenant export keeps its limits.
