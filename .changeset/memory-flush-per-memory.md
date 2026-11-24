---
"@agentifiers/deployments-cli": minor
"@agentifiers/deployments-sdk": minor
---

A memory flush drops an invalid memory on its own and keeps the rest of the batch. Before, one memory with an inverted validity window, a bad entity key, or missing content rejected the whole flush. A `null` validity bound now means that side is open, and a memory whose `validUntil` equals its `validFrom` keeps `validFrom` and never expires. Dropped memories count toward the flush's `rejectedCount`. Installations can run flushes on one model by setting `memory_runtime_flush_model`. A flush uses it only when the run's environment model policy admits it, and otherwise keeps the agent's model. The plan rejects a flush model equal to `memory_runtime_embedding_model` or `memory_runtime_rerank_model`, because the memory service admits those without the environment's policy. The flush record's `completionModelId` names the model that ran. It is unset by default, and then the flush keeps the agent's model.
