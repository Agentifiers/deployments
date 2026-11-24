---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

`createAgentDefinition` takes an optional `workspaceId` that gives the definition to an active workspace in the environment. The definition's slug is then unique within that workspace, so two workspaces, or a workspace and the environment, can each hold a definition with the same `metadata.key`. An unknown workspace fails with `404 resource_not_found` and an inactive one with `409 workspace_unavailable`. Agent definition responses and list items include `workspaceId` when it is set. Updates keep the workspace and cannot change it.
