---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Find an agent-built app by its slug. `listApps` (`GET /v1/apps`) takes `slug` and then returns that app, or an empty list when no app in the environment has the slug, from one read instead of a page per 100 apps. `deployments app list --slug <slug>` calls it.
