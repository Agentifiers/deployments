---
"@agentifiers/deployments-cli": minor
"@agentifiers/deployments-sdk": minor
---

Add agent-built apps, internal web apps that deployed agents build with the `app.*` tools. Ten operations under `/v1/apps` list, read, update, archive, and erase apps (`listApps`, `getApp`, `updateApp`, `archiveApp`, `eraseApp`), manage member grants (`listAppGrants`, `putAppGrant`, `removeAppGrant`), and list and promote releases (`listAppReleases`, `promoteAppRelease`). They take a platform bearer token and the `x-deployments-environment` header. Reads need `apps:read`. Changes need `apps:write`, the owner or admin role, a human principal, and an `Idempotency-Key`, and an API key that tries one gets 403 `human_principal_required`. `eraseApp` answers 202 and deletes the app's database, roles, host routing, release files, and records. The app's slug is never reused. The CLI adds `deployments app list`, `show`, `update`, `archive`, and `erase`, `deployments app-grant list`, `set`, and `remove`, and `deployments app-release list` and `promote`. Tenant data exports now include one CSV per table of every active or archived app.
