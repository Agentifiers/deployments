---
"@agentifiers/deployments-cli": minor
"@agentifiers/deployments-sdk": minor
---

Usage and cost summaries per agent: `GET /v1/usage/summary` and `GET /v1/costs/summary` accept `agentDefinitionId` and then cover only usage of runs that executed that agent definition, including its input, output, cached, and cache-write token splits. The usage materializer keeps hourly per-agent counters for every run-attributed meter event (model tokens, worker time, run-owned sandboxes, memory reranking, Brain retrievals during runs), resolving the agent from the event's run; usage outside runs belongs to no agent, and usage before this release has no agent counters. `deployments usage summary` and `deployments cost summary` add `--definition`.
