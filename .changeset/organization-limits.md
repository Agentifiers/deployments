---
"@agentifiers/deployments-cli": minor
"@agentifiers/deployments-sdk": minor
---

Organizations run under per-organization limits on API request rate and burst, concurrent runs, and active sandboxes. Any active member can read the effective values with `getOrganizationLimits` (`GET /v1/organizations/{id}/limits`, `organizations:read`), which reports each limit's `value` and whether its `source` is the platform `default` or an operator `override`. Platform administrators read and change overrides with `getSystemOrganizationLimits`, `replaceSystemOrganizationLimits`, and `clearSystemOrganizationLimits` (`GET|PUT|DELETE /v1/system/organizations/{organizationId}/limits`). A change requires a `reason`, and a value outside its bounds answers 400 with the offending `field`. The CLI adds `deployments org limits` and `deployments system limits|set-limits|clear-limits`.
