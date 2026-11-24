---
"@agentifiers/deployments-cli": patch
"@agentifiers/deployments-sdk": patch
---

Build the public OpenAPI document only when something asks for it instead of when the SDK or CLI loads. `deployments --help` starts in about 104 ms instead of 144 ms on an Apple Silicon Mac.
