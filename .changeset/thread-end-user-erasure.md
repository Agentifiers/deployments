---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Erase one thread, or every thread of one of your end users, without erasing the organization. `runtime.threads.erase`, `runtime.threads.getErasure`, and `runtime.threads.waitForErasure` start and poll a thread erasure (scope `runs:erase`). `runtime.endUsers.erase({ endUserId })`, `runtime.endUsers.getErasure`, and `runtime.endUsers.waitForErasure` do the same for an end user (scope `end-users:erase`). Thread creation and run submission accept an optional `endUserId` that ties a new thread to your end user; the platform keeps only a keyed pseudonym of it. The CLI adds `deployments thread erase`, `deployments thread erasure-status`, `deployments end-user erase`, and `deployments end-user erasure-status`, and the erase commands ask for confirmation unless you pass `--yes`.
