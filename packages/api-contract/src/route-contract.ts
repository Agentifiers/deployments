export type PublicApiAuthentication =
  /** Runtime routes: a service-account API key, or a platform bearer JWT plus tenant headers. */
  | "api-credential-or-platform-bearer"
  | "none"
  | "platform-bearer"
  | "stream-session"
  | "tenant-jwt";

export type PublicApiIdempotency = "none" | "optional" | "required" | "required-or-body";
export type PublicApiMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
export type PublicApiPrincipal = "human" | "service-account";
export type PublicApiScopeHeaders =
  | "environment"
  | "none"
  | "optional-tenant"
  | "organization"
  | "project"
  | "tenant";

export interface PublicApiQueryParameter {
  readonly description?: string;
  readonly name: string;
  readonly required?: boolean;
  readonly schema: Readonly<Record<string, unknown>>;
}

export interface PublicApiPathParameter {
  readonly description?: string;
  readonly name: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

/**
 * What a suspended organization may still do through a non-GET route. `read` only reads
 * (searches, exports); `remediation` reduces access or activity; `erasure` destroys customer data
 * and stays refused while a hold preserves evidence; `distribution` mints a link that serves
 * customer data to whoever holds it and stays refused while a hold stops running work. A non-GET
 * route without it is refused with `403 organization_suspended` while the organization is
 * suspended.
 */
export type PublicApiStanding = "distribution" | "erasure" | "read" | "remediation";

export interface PublicApiRouteContract {
  readonly authentication: PublicApiAuthentication;
  readonly errors: readonly number[];
  readonly idempotency: PublicApiIdempotency;
  readonly method: PublicApiMethod;
  readonly name: string;
  readonly path: string;
  readonly pathParameters?: readonly PublicApiPathParameter[];
  readonly principals?: readonly PublicApiPrincipal[];
  readonly queryParameters?: readonly PublicApiQueryParameter[];
  readonly requestBody?: string;
  readonly requestBodyRequired?: boolean;
  readonly requiredAuthorization?: string;
  readonly responseBody: string;
  readonly responseContentType?: string;
  /** Alternative media type for live reads that negotiate Server-Sent Events. */
  readonly eventStreamContentType?: "text/event-stream";
  readonly scopeHeaders: PublicApiScopeHeaders;
  /**
   * Service that serves the operation when it is not the public API origin. Clients use the
   * absolute URL the API returns for it instead of composing one.
   */
  readonly server?: "stream-gateway";
  readonly standing?: PublicApiStanding;
  readonly successStatus: number;
  readonly tag:
    | "Agent Email"
    | "Agents"
    | "Alerts"
    | "Apps"
    | "Artifacts"
    | "Automations"
    | "Budgets"
    | "Brains"
    | "Email"
    | "Evaluations"
    | "Extensions"
    | "Governance"
    | "Managed Skills"
    | "Memory"
    | "Models"
    | "Operations"
    | "Observability"
    | "Providers"
    | "Runtime"
    | "Security"
    | "System"
    | "Tenancy"
    | "Tools"
    | "Workflows";
}
