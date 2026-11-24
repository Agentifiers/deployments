---
"@agentifiers/deployments-cli": minor
"@agentifiers/deployments-sdk": minor
---

Identity provider responses gain an optional `endpoints.userinfo`, the provider's `userinfo_endpoint` from discovery. Saving a provider now stores that endpoint when the discovery document has one, and a `userinfo_endpoint` that is not `https:` fails the save with 422 `discovery_insecure_endpoint`. When an ID token has neither a boolean `email_verified` nor a boolean `xms_edov`, federated sign-in reads `email`, `email_verified`, and `hd` from the provider's userinfo endpoint instead, so Okta members can sign in. A userinfo response that cannot be read fails the sign-in with `userinfo_failed`, and one about another subject fails it with `userinfo_subject_mismatch`. A provider saved before this release has no stored userinfo endpoint until an administrator saves it again with the same issuer and client ID, which keeps its `connectionId` and needs no secret.
