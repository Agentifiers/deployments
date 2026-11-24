---
"@agentifiers/deployments-cli": minor
"@agentifiers/deployments-sdk": minor
---

Members can read their organization's standing. `getOrganizationStanding` (`GET /v1/organizations/{id}/standing`, CLI `deployments org standing <id>`) returns `state` (`active` or `suspended`), `suspendedAt`, each hold's `reason`, `customerMessage`, and `since`, and the effective tenant limits and operator-funded model spend ceiling. It never shows who placed a hold or the operator's notes.

While an organization is suspended, the API answers every change with `403 organization_suspended`, whose problem body lists each hold's `reason`, `customerMessage`, and `since`. Reads still answer, and so do the routes that only read (searches, exports, access URLs), reduce access or activity (revoking API keys, service accounts, credentials, connections, and grants; removing members and invitations; pausing schedules and heartbeats; cancelling runs, workflow executions, and email drafts; disabling webhooks; stopping deployments; updating or archiving budgets), or erase customer data (tenant, thread, and end-user erasure, except while an `abuse` hold preserves evidence). Each such route says so in its OpenAPI description.
