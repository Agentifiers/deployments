---
"@agentifiers/deployments-cli": minor
"@agentifiers/deployments-sdk": minor
---

Spend budgets can govern one workspace. `createBudget` (`POST /v1/budgets`, CLI `deployments budget create --scope workspace --environment-id <id> --workspace-id <id>`) accepts `scope: "workspace"` with the workspace's `environmentId` and `workspaceId`, and budget responses carry `workspaceId`. A workspace budget refuses new runs in that workspace once its period's spend reaches the amount, including follow-up turns on a thread that belongs to the workspace, and its `budget.threshold-crossed` events name the workspace. Creating one for an archived workspace answers 409 `workspace_not_active`.
