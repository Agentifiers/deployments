---
"@deployments-ai/cli": minor
"@deployments-ai/sdk": minor
---

Platform administrators can disable or re-enable a person with `replaceSystemPrincipalStatus` (`PUT /v1/system/principals/{principalId}/status`, body `{ status: "active" | "disabled", reason }`) or `deployments system set-principal-status`. Disabling ends the person's sessions and refresh tokens, and their next request returns 401. Re-enabling does not revive them. The response reports `changed: false` when the status was already set. Administrators cannot disable themselves (`403 cannot_disable_self`), machine services cannot call the route, and an install without platform identity answers `409 principal_status_unmanaged`.

`createOrganization` now refuses with `403 email_verification_required` when the creator's access token does not carry a verified email on an install that trusts platform identity, `403 organization_creation_held` while an organization the creator owns or administers has a hold, and `403 organization_quota_reached` once the creator has used the install's optional lifetime quota (`organization_creation_quota_per_principal`). Platform administrators are exempt. Platform identity access tokens now carry an `email_verified` claim.
