---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Runs can be listed across the whole environment and read without their thread. `GET /v1/runs` and `POST /v1/runs/search` accept at most one of `agentDeploymentId` and `executionBindingId`; with neither they return every run in the environment, newest first. All run listings accept `executionPurpose`, `agentReleaseId`, `threadId`, `status`, and inclusive `createdAfter`/`createdBefore` filters. The new `GET /v1/runs/:runId` returns a run of the caller's environment. The SDK adds `runs.getById(runId)`, makes `runs.list` options optional, and accepts the new filters on `runs.list` and `runs.search`; the CLI adds `deployments run get <runId>` plus `--execution-purpose`, `--execution-binding-id`, `--thread`, and creation-time flags, and `run list`/`run search` no longer require `--agent-deployment-id`.
