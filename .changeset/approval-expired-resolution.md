---
"@agentifiers/deployments-cli": patch
"@agentifiers/deployments-sdk": patch
---

Approval resolution responses now accept `decision: "expired"`, which the API returns when an approval is resolved after its `expiresAt`, instead of rejecting the response as outside the contract.
