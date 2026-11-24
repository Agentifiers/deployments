---
"@agentifiers/deployments-cli": minor
"@agentifiers/deployments-sdk": minor
---

Observability traces now carry their root run's agent definition, deployment, release, release selection, trigger, execution purpose, error class, and duration, and trace lists filter by `agentDefinitionId`, `agentDeploymentId`, `agentReleaseId`, `executionPurpose`, and `errorClass` (`deployments trace list|session --definition --deployment --release --purpose --error-class`). `observability.metrics()` accepts `from`, `to`, `interval` (`hour`/`day`), and `groupBy` (agent definition, deployment, or release over traces with p50/p95 duration; `model` or `provider` over model invocations with tokens, cost, and p50/p95 latency) and now returns `{ from, to, interval, groupBy?, source, items }` (`deployments observability metrics --from --to --interval --group-by`). `observability.tools()` accepts `from`, `to`, and `agentDeploymentId` and returns its window (`deployments observability tools --from --to --deployment`). Unknown or invalid observability query parameters are rejected with `invalid_query_parameter`.
