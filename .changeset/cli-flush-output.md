---
"@deployments-ai/cli": patch
"@deployments-ai/sdk": patch
---

Flush stdout and stderr before the CLI exits so large JSON output (such as `deployments catalog --json`) is not cut off at the first pipe buffer when the reading process is slow.
