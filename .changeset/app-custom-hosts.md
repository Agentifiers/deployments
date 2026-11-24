---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Serve agent-built apps on their active custom domains. The app gateway answers a custom hostname only while it is an `active` domain of the app, and answers 404 for any other hostname, including `unverified` and `verified` domains, before it reads the app or its database. A detached domain stops serving pages and API calls within 5 seconds. Members sign in on a custom domain only when a person attached it. On a domain an API key attached, sign-in moves to the app's slug URL. A session works only on the host where it was issued, and the sign-in callback checks the domain again before it sends the member back to it.
