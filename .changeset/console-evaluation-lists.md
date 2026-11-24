---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

List evaluation history: `evaluations.listEvaluationRuns` (filters `status`, `datasetId`, `agentReleaseId`) and `evaluations.listReleaseComparisons` (filters `status`, `baselineReleaseId`, `candidateReleaseId`) return the environment's runs and comparisons newest first with cursor paging, and the CLI adds `deployments eval run list` and `deployments eval comparison list`. Comparison list items omit `report`; fetch the comparison for its download URLs.
