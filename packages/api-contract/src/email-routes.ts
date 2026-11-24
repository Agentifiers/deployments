import type { PublicApiRouteContract } from "./route-contract.ts";

type EmailRouteInput = Omit<
  PublicApiRouteContract,
  "authentication" | "errors" | "scopeHeaders" | "tag"
>;
function emailRoute<const Contract extends EmailRouteInput>(
  contract: Contract,
): PublicApiRouteContract & Contract {
  return {
    authentication: "platform-bearer",
    errors: [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504],
    scopeHeaders: "environment",
    tag: "Email",
    ...contract,
  };
}
const listQueryParameters = [
  { name: "cursor", schema: { maxLength: 4_096, minLength: 1, type: "string" } },
  { name: "limit", schema: { maximum: 100, minimum: 1, type: "integer" } },
] as const;

export const EMAIL_API_ROUTES = [
  emailRoute({
    name: "createEmailTenant",
    method: "POST",
    path: "/v1/email/tenants",
    requestBody: "CreateEmailTenantRequest",
    responseBody: "EmailTenantResponse",
    requiredAuthorization: "email:admin",
    idempotency: "required",
    successStatus: 201,
  }),
  emailRoute({
    name: "listEmailTenants",
    method: "GET",
    path: "/v1/email/tenants",
    responseBody: "EmailTenantPageResponse",
    queryParameters: listQueryParameters,
    requiredAuthorization: "email:read",
    idempotency: "none",
    successStatus: 200,
  }),
  emailRoute({
    name: "getEmailTenant",
    method: "GET",
    path: "/v1/email/tenants/:tenantId",
    responseBody: "EmailTenantResponse",
    requiredAuthorization: "email:read",
    idempotency: "none",
    successStatus: 200,
  }),
  emailRoute({
    name: "updateEmailTenant",
    method: "PATCH",
    path: "/v1/email/tenants/:tenantId",
    requestBody: "UpdateEmailTenantRequest",
    responseBody: "EmailTenantResponse",
    requiredAuthorization: "email:admin",
    idempotency: "required",
    successStatus: 200,
  }),
  emailRoute({
    name: "createEmailDomain",
    method: "POST",
    path: "/v1/email/tenants/:tenantId/domains",
    requestBody: "CreateEmailDomainRequest",
    responseBody: "EmailDomainResponse",
    requiredAuthorization: "email:admin",
    idempotency: "required",
    successStatus: 201,
  }),
  emailRoute({
    name: "listEmailDomains",
    method: "GET",
    path: "/v1/email/tenants/:tenantId/domains",
    responseBody: "EmailDomainPageResponse",
    queryParameters: listQueryParameters,
    requiredAuthorization: "email:read",
    idempotency: "none",
    successStatus: 200,
  }),
  emailRoute({
    name: "getEmailDomain",
    method: "GET",
    path: "/v1/email/domains/:domainId",
    responseBody: "EmailDomainResponse",
    requiredAuthorization: "email:read",
    idempotency: "none",
    successStatus: 200,
  }),
  emailRoute({
    name: "refreshEmailDomain",
    method: "POST",
    path: "/v1/email/domains/:domainId/refresh",
    responseBody: "EmailDomainResponse",
    requiredAuthorization: "email:admin",
    idempotency: "required",
    successStatus: 200,
  }),
  emailRoute({
    name: "revokeEmailDomain",
    method: "DELETE",
    path: "/v1/email/domains/:domainId",
    responseBody: "EmailDomainResponse",
    requiredAuthorization: "email:admin",
    idempotency: "required",
    successStatus: 200,
  }),
  emailRoute({
    name: "sendEmail",
    method: "POST",
    path: "/v1/email/tenants/:tenantId/messages",
    requestBody: "SendEmailRequest",
    responseBody: "EmailSendResponse",
    requiredAuthorization: "email:write",
    idempotency: "required",
    successStatus: 202,
  }),
] as const satisfies readonly PublicApiRouteContract[];
export type EmailApiRouteName = (typeof EMAIL_API_ROUTES)[number]["name"];
