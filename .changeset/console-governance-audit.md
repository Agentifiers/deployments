---
"@agentifiers/deployments-cli": minor
"@agentifiers/deployments-sdk": minor
---

Add governance operation history and the organization audit log. `deployments governance operations <organization-id>` lists tenant exports, tenant erasures, and immutable audit exports newest first with `--kind` and `--status` filters (`GET /v1/organizations/:id/governance-operations`). `deployments audit organization-list <organization-id>` lists organization-level audit events (organization, membership, invitation, project, environment lifecycle, retention policy, and governance requests) with the same `--since`, `--until`, `--actor`, `--resource`, and `--event` filters as `audit list` (`GET /v1/organizations/:id/audit-events`).
