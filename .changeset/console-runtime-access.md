---
"@deployments-ai/cli": patch
"@deployments-ai/sdk": patch
---

Runtime operations (runs, threads, approvals, artifacts, channels, webhooks, schedules, heartbeats, previews, and workflow executions) now accept a human platform bearer JWT as well as an API key. JWT callers must send the `x-deployments-organization`, `x-deployments-project`, and `x-deployments-environment` headers and need an active organization membership; mutations require the owner or admin role, and approvals they resolve record their principal ID. The OpenAPI document, including the one the SDK mock serves at `/v1/openapi.json`, lists both `apiCredentialBearer` and `platformBearer` on these operations. API-key behavior is unchanged.
