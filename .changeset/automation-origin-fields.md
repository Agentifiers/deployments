---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Schedule, heartbeat, and run responses gain optional fields that trace an automation to its creator and its runs. `createdBy` names the actor that created a schedule or heartbeat: the calling principal or service account, or the agent deployment for the built-in scheduling tools. `createdFrom` names the tool call (`runId`, `threadId`, `toolCallId`, and `toolName`) when `agent.schedule.create` or `agent.schedule.remind` created a schedule. Runs started by a schedule or heartbeat fire carry `automation` with the automation's `kind`, `id`, and `fireId`. Replays do not. Automations created before the API recorded these fields have no `createdBy` or `createdFrom`.
