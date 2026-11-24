---
"@agentifiers/deployments-cli": minor
"@agentifiers/deployments-sdk": minor
---

Read an organization's spend for a UTC month, split by who paid. `getOrganizationSpend` (`GET /v1/organizations/{id}/spend?month=YYYY-MM`, CLI `deployments org spend <id> --month YYYY-MM`) lets any member see `totalUsdMicros`, `operatorFundedUsdMicros`, `organizationFundedUsdMicros`, `periodStart`, `asOf`, `month`, and the organization's effective `operatorFundedModelSpendCeiling`. `getSystemOrganizationSpend` (`GET /v1/system/organizations/{organizationId}/spend`, CLI `deployments system spend <organization-id>`) returns the same split without the ceiling to administrators, and to machine services with the `organization-read` grant at `/v1/system/services/organizations/{organizationId}/spend`. `month` defaults to the current UTC month; a malformed or future month returns `400 invalid_month`.

The usage materializer emits `organization.operator-funded-spend-exhausted` with `organizationId`, `month`, `ceilingUsdMicros`, and `operatorFundedUsdMicros` at most once per organization and month, when operator-funded spend reaches a finite effective ceiling.
