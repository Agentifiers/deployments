---
"@agentifiers/deployments-cli": minor
---

`deployments grant create --all-workspaces` creates an environment grant. It sends `workspaceId: null`, so runs in every workspace of the environment can use the connection. `--workspace` is no longer a required flag, but the command needs exactly one of `--workspace` and `--all-workspaces`. Passing both or neither exits with code 2 before any request is sent.
