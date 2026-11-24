---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Add organization model provider keys. `listModelCredentials` and `getModelCredential` (`GET /v1/organizations/{organizationId}/model-credentials` and `.../{provider}`) show each stored key by provider, status, last four characters, and key version, and never return the key. `putModelCredential` (`PUT .../{provider}`) verifies an `openai` or `openrouter` key by listing the provider's models, then stores or replaces it and increments its key version. A key the provider refuses returns `422 model_credential_rejected` and is not stored. `deleteModelCredential` (`DELETE .../{provider}`) removes the key and keeps its metadata. These operations take the `x-deployments-organization` header and need the owner or admin role, with `models:read` for reads and `models:write` for changes. An installation that has not enabled the provider returns `404 model_credentials_not_enabled`. The CLI adds `deployments model-credential list`, `show`, `set`, and `remove`; `set` reads the key from `--api-key-env` or `--api-key-file`.
