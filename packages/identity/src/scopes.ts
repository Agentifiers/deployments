const LITERAL_CREDENTIAL_SCOPES: Readonly<Record<string, true>> = { "apps:publish": true };

export function platformScopePermits(grants: readonly string[], required: string) {
  if (
    grants.includes("platform:*") ||
    grants.includes("platform:admin") ||
    grants.includes(required)
  ) {
    return true;
  }
  return grants.includes(`${required.split(":", 1)[0]}:*`);
}

export function credentialWildcardsCannotGrant(scope: string) {
  return Object.hasOwn(LITERAL_CREDENTIAL_SCOPES, scope);
}

export function credentialScopePermits(grants: readonly string[], required: string) {
  return credentialWildcardsCannotGrant(required)
    ? grants.includes(required)
    : platformScopePermits(grants, required);
}
