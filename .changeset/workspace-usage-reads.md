---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Read a workspace's spend, usage, and costs. `getWorkspaceSpend` (`GET /v1/workspaces/{id}/spend?month=YYYY-MM`, CLI `deployments workspace spend <id> --month YYYY-MM`) returns `totalUsdMicros`, `operatorFundedUsdMicros`, `organizationFundedUsdMicros`, `periodStart`, `asOf`, `month`, `workspaceId`, and `environmentId` for one workspace of the `x-deployments-environment` environment. It needs `spend:read`, reads archived workspaces too, returns `404 not_found` for a workspace outside that environment, and `400 invalid_month` for a malformed or future month. `getUsageSummary` and `getCostSummary` accept `workspaceId` (CLI `--workspace-id`) and then cover only usage that names that workspace, with its token splits; combining it with `agentDefinitionId` returns `400 invalid_query`.
