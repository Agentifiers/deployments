---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Add vendor-hosted MCP connector support: the `syncConnectionTools` operation (`POST /v1/connections/:connectionId/tools/sync`) and `deployments connection tools-sync <connectionId>` discover and sync a vendor MCP connection's tools; `oauth-app register` accepts `--registration '{"method":"pre_registered"}'` for vendor MCP providers, and its client secret is optional when the registration uses token endpoint authentication `none`. `credential create` accepts `--resource` (`requestedResource` on `POST /v1/credentials`) for the tenant endpoint of templated API-key vendor MCP servers such as Freshdesk.

`returnTo` on `beginProviderAuthorization` (`POST /v1/connections`) and `deployments connection authorize --return-url` is optional and must be an absolute `https:` URL, without userinfo or a fragment, whose origin is in the deployment's `PLATFORM_OAUTH_RETURN_ORIGINS` allowlist; any other value fails with 422 `invalid_return_to`, and it no longer defaults to `/`. The public OAuth callback now answers the browser instead of returning JSON: it redirects (303) to `returnTo` with `connection_id` and `provider` query parameters on success, or `error=access_denied` / `error=authorization_failed` on failure, and renders a static HTML page when `returnTo` was omitted or the authorization state is invalid.
