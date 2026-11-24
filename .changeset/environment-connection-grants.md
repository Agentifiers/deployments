---
"@agentifiers/deployments-cli": minor
"@agentifiers/deployments-sdk": minor
---

`createConnectionGrant` (`POST /v1/connection-grants`) accepts `workspaceId: null` to grant a connection to every workspace in the environment. `workspaceId` stays a required key. Only a connection whose provider needs no credential and no verification, such as `extension_callback`, can get an environment grant. Any other connection fails with `422 environment_grant_requires_credentialless_connection`. Grant responses and list items report `workspaceId: null` for an environment grant. Runs in any workspace of the environment can use it, and a run without a workspace still cannot. The platform checks the provider each time a run uses the grant, so an environment grant stops authorizing runs if its provider later needs a credential.
