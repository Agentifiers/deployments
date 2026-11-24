---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Add publication settings to agent-built apps. Every app response now carries `publication: { audience, serving }`, where `audience` is `members` or `public` and `serving` is `single-page` or `static-site`. An app that never set them reports `members` and `single-page`. `setAppPublication` (`PATCH /v1/apps/{appId}/publication`) changes either field or both, with an `Idempotency-Key`, and `deployments app set-publication <id> --audience public --serving static-site` calls it. Setting `audience` to `public` first brings the app's database up to the current layout, and so does the first `app.migrate` on an app created before this release. For 10 minutes after that step starts, an erase of the app is refused with 409 `app_state_conflict`, so the step cannot recreate the database of an erased app.

The route needs the new `apps:publish` scope. Members also need the owner or admin role. A service-account API key may call it only when the key and its service account both name `apps:publish`, because `apps:*` and `platform:*` do not grant it to API keys. A key can create a service account or key that names `apps:publish` only when the key names it too. Every other app change still needs a human principal. CLI and console sessions request `apps:publish` from now on, so a member who signed in before this release must sign in again to publish.
