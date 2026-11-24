---
"@deployments-ai/cli": patch
"@deployments-ai/sdk": patch
---

Resend a request that the API gateway throttled. The gateway answers `429` with `{"message":"Too Many Requests"}` before the platform runs the request, so the SDK and the CLI now resend it after 0.25, 0.5, 1, 2, and 4 seconds and return the last answer. A `429` from the platform, such as `organization_rate_limited`, still comes back without a resend.
