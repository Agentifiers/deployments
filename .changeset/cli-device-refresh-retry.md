---
"@agentifiers/deployments-cli": patch
---

A device token refresh that fails for a transient reason no longer logs the CLI out. Before, a network error, timeout, or `5xx` from `/v1/device-authorizations/token`, or a failed `/v1/whoami` check after the exchange, removed the stored refresh token, so the next command asked for `deployments auth login`. Now the profile keeps its refresh token and the next command refreshes again. When the exchange succeeded but the identity check failed, the profile keeps the rotated refresh token and not the unchecked bearer. Only `invalid_grant`, `invalid_client`, or `unauthorized_client` marks the profile for a new login. Concurrent commands still share one token exchange through the per-profile refresh lock.

Within one command, a transient exchange failure is resent up to twice. The 30-second refresh deadline now bounds every resend and the `/v1/whoami` check together; before, on Bun, the deadline stopped after the first resend delay.

A `200` from the token endpoint whose body is cut off or unreadable counts as a lost response and is resent, because identity-api already rotated the token. Before, it failed the command with `null is not an object`.
