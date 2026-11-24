---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

The organization governance history now covers thread and end-user erasures. `listGovernanceOperations` (`GET /v1/organizations/:id/governance-operations`) returns them with kind `thread-erasure` or `end-user-erasure` and accepts both in its `kind` filter. Each item has the erasure's `id`, `status`, `environmentId`, `threadId` for a thread erasure, `phase`, `counts`, timestamps, and an `error` only when it failed. It never names the end user. `deployments governance operations --kind` lists the five kinds in its help.
