---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Add Amazon Bedrock as a model provider. Model ids take the form `bedrock/<foundation model or inference profile id>` (for example `bedrock/us.anthropic.claude-haiku-4-5-20251001-v1:0`). The model catalog `provider` filter, `model list --provider` options, and the SDK `MockModelProvider` type now accept `bedrock` alongside `openai` and `openrouter`.
