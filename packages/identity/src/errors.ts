export type IdentityErrorCode =
  | "access_denied"
  | "authorization_pending"
  | "consent_required"
  | "expired_token"
  | "human_verification_failed"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_request"
  | "invalid_scope"
  | "login_required"
  | "server_error"
  | "slow_down"
  | "temporarily_unavailable"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "unsupported_response_type";

export class IdentityError extends Error {
  readonly code: IdentityErrorCode;
  readonly exposeDescription: boolean;
  readonly status: number;

  constructor(
    code: IdentityErrorCode,
    message: string,
    options: {
      readonly exposeDescription?: boolean;
      readonly status?: number;
    } = {},
  ) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
    this.exposeDescription = options.exposeDescription ?? false;
    this.status = options.status ?? (code === "invalid_client" ? 401 : 400);
  }
}

export function oauthErrorBody(error: IdentityError) {
  return {
    error: error.code,
    ...(error.exposeDescription ? { error_description: error.message } : {}),
  };
}
