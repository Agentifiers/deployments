---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Platform administrators can find a person and act on their sign-in. `findSystemPrincipal` (`GET /v1/system/principals?email=`) matches a whole email and returns the person or a pending sign-up. `getSystemPrincipal` returns the person's organizations (up to 100), multi-factor state, and session counts. `listSystemPrincipalSecurityEvents` pages their security events newest first, and withholds secret payload fields. `revokeSystemPrincipalSessions` ends every session without disabling the person. `resendSystemPrincipalVerification` resends a pending sign-up's verification email under the self-service limits. `deployments system people find|show|events|revoke-sessions|resend-verification` calls them.
