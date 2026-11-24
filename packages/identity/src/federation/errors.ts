const FEDERATION_ERROR_MESSAGES = {
  issuer_invalid: "The issuer must be an https URL without credentials, query, or fragment.",
  idp_url_not_allowed: "Identity provider URLs must use https and resolve to public addresses.",
  idp_request_failed: "The request to the identity provider failed.",
  discovery_failed: "The identity provider discovery document could not be read.",
  discovery_issuer_mismatch: "The discovery document names a different issuer.",
  discovery_insecure_endpoint: "The identity provider advertises an endpoint that is not https.",
  discovery_code_flow_unsupported:
    "The identity provider does not support the authorization code flow.",
  discovery_signing_algorithm_unsupported:
    "The identity provider does not sign ID tokens with RS256, PS256, or ES256.",
  discovery_client_auth_unsupported:
    "The identity provider supports neither client_secret_basic nor client_secret_post.",
  token_exchange_failed: "The identity provider did not exchange the authorization code.",
  jwks_failed: "The identity provider signing keys could not be read.",
  id_token_signature_invalid: "The ID token is malformed or its signature is invalid.",
  id_token_issuer_mismatch: "The ID token was issued by a different issuer.",
  id_token_audience_mismatch: "The ID token was issued to a different client.",
  id_token_expired: "The ID token has expired.",
  id_token_not_yet_valid: "The ID token is not valid yet.",
  id_token_stale: "The ID token was issued too long ago.",
  id_token_nonce_mismatch: "The ID token does not belong to this sign-in attempt.",
  id_token_claims_invalid: "The ID token is missing a required claim.",
  id_token_reauthentication_missing: "The identity provider did not reauthenticate the user.",
  userinfo_failed: "The identity provider userinfo response could not be read.",
  userinfo_subject_mismatch: "The userinfo response describes a different user than the ID token.",
} as const satisfies Record<string, string>;

export type FederationErrorCode = keyof typeof FEDERATION_ERROR_MESSAGES;

export class FederationError extends Error {
  readonly code: FederationErrorCode;

  constructor(code: FederationErrorCode, options?: ErrorOptions) {
    super(FEDERATION_ERROR_MESSAGES[code], options);
    this.name = "FederationError";
    this.code = code;
  }
}
