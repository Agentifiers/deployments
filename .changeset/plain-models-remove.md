---
"@agentifiers/deployments-cli": patch
"@agentifiers/deployments-sdk": patch
---

Remove the unsupported `featherless` and `vllm` model providers. The model catalog `provider` filter, `model list --provider` options, and the SDK `MockModelProvider` type now accept only `openai` and `openrouter`.
