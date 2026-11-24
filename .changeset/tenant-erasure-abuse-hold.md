---
"@deployments-ai/sdk": patch
"@deployments-ai/cli": patch
---

A tenant erasure accepted before an abuse hold was placed now stays `pending` until that hold is released. Before, the erasure ran anyway. Erasures under payment, policy, and manual holds still run, and exports still run under any hold.
