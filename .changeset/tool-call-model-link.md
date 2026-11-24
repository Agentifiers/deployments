---
"@agentifiers/deployments-cli": minor
"@agentifiers/deployments-sdk": minor
---

Tool calls name the model generation that requested them. `GET /v1/runs/{runId}/tool-calls` returns `modelCallIndex` and `modelAttemptId` together on every tool call a model generation requested, and neither on tool-plan calls; both survive a checkpoint resume. Observability spans (`GET /v1/observability/traces/{traceId}/spans`) add `model_call_index` and `invocation_kind` (`assistant` or `response-depth`) to model spans. A model-requested tool span now carries the requesting `attempt_id` and `model_call_index`, and its `parent_span_id` is that model attempt's span; other tool spans keep the run span as parent.
