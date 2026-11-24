variable "platform_identity_enabled" {
  description = "Whether to deploy the platform identity provider."
  type        = bool
  default     = false
}

variable "deploying_role_name" {
  description = "Name of the IAM role in this account that runs deployments; the identity provider lets only this role bootstrap OAuth clients."
  type        = string
  default     = "github-deploy"
  nullable    = false
}

variable "platform_identity_application_origin" {
  description = "Browser application origin served by the identity provider."
  type        = string
}

variable "platform_identity_api_artifact_bucket" {
  description = "S3 bucket containing the identity API Lambda artifact."
  type        = string
  default     = ""
}

variable "platform_identity_api_artifact_key" {
  description = "S3 key containing the identity API Lambda artifact."
  type        = string
  default     = ""
}

variable "platform_identity_api_artifact_version" {
  description = "Immutable S3 object version for the identity API Lambda artifact."
  type        = string
  default     = ""
}

variable "platform_identity_api_reserved_concurrency" {
  description = "Reserved Lambda concurrency for the identity API, or null for unreserved concurrency."
  type        = number
  default     = 20
}

variable "platform_identity_additional_clients" {
  description = "Confidential OAuth clients the install operator declares for its own services, keyed by client ID. The platform_identity_bootstrap output names each client's secret parameter. Validated by the platform-identity module."
  type = map(object({
    allowed_scopes = list(string)
    name           = string
    redirect_uris  = list(string)
  }))
  default  = {}
  nullable = false
}

variable "platform_identity_certificate_arn" {
  description = "ACM certificate ARN for the identity domain."
  type        = string
  default     = ""
}

variable "platform_identity_cli_redirect_uris" {
  description = "Loopback redirect URIs accepted for CLI authorization."
  type        = list(string)
  default     = ["http://127.0.0.1/callback", "http://[::1]/callback"]
}

variable "platform_identity_domain_name" {
  description = "Identity issuer hostname."
  type        = string
}

variable "platform_identity_email_artifact_bucket" {
  description = "S3 bucket containing the identity email worker Lambda artifact."
  type        = string
  default     = ""
}

variable "platform_identity_email_artifact_key" {
  description = "S3 key containing the identity email worker Lambda artifact."
  type        = string
  default     = ""
}

variable "platform_identity_email_artifact_version" {
  description = "Immutable S3 object version for the identity email worker Lambda artifact."
  type        = string
  default     = ""
}

variable "platform_identity_email_sender" {
  description = "Sender address for identity email."
  type        = string
}

variable "platform_identity_human_verification" {
  description = "Siteverify-compatible human verification required on self-service sign-up and password recovery. Null requires none."
  type = object({
    response_field        = string
    script_url            = string
    secret_parameter_name = string
    site_key              = string
    verify_url            = string
    widget_class          = string
    widget_origins        = optional(list(string), [])
  })
  default = null
}

variable "platform_identity_resource_audience" {
  description = "Resource audience of platform identity access tokens."
  type        = string
}

variable "platform_identity_publish_domain" {
  description = "Whether the identity domain is published and becomes the platform JWT issuer."
  type        = bool
  default     = false
}

variable "platform_identity_registration_enabled" {
  description = "Whether self-service registration is open."
  type        = bool
  default     = false
}

variable "platform_identity_route53_zone_id" {
  description = "Route 53 hosted zone containing the identity domain."
  type        = string
  default     = ""
}

variable "platform_identity_web_redirect_uris" {
  description = "Web application redirect URIs accepted by the identity provider."
  type        = list(string)
}

variable "runtime_jwt_from_platform_identity" {
  description = "Whether the memory and channel/provider runtimes trust the published platform identity issuer, audience, and JWKS instead of their explicit JWT inputs."
  type        = bool
  default     = false
}

variable "platform_api_enabled" {
  description = "Whether to deploy the unified public product API."
  type        = bool
  default     = false
}

variable "platform_api_artifact_bucket" {
  description = "S3 bucket containing the bundled functions/api Lambda artifact."
  type        = string
  default     = ""
}

variable "platform_api_artifact_key" {
  description = "S3 key containing the bundled functions/api Lambda artifact."
  type        = string
  default     = ""
}

variable "platform_api_artifact_version" {
  description = "Immutable S3 object version for the bundled functions/api Lambda artifact."
  type        = string
  default     = ""
}

variable "platform_api_certificate_arn" {
  description = "ACM certificate ARN for platform_api_domain_name."
  type        = string
  default     = ""
}

variable "platform_api_domain_name" {
  description = "Canonical hostname for the unified public product API."
  type        = string
  default     = ""
}

variable "platform_api_device_authorization_client_id" {
  description = "RFC 8628 OAuth client ID used when the platform identity domain is not published."
  type        = string
  default     = ""
}

variable "platform_api_device_authorization_issuer" {
  description = "OIDC issuer advertising RFC 8628 endpoints when the platform identity domain is not published."
  type        = string
  default     = ""
}

variable "platform_api_e2e_callback_fixture_enabled" {
  description = "Whether the API exposes the end-to-end webhook callback fixture."
  type        = bool
  default     = false
}

variable "platform_api_e2e_mcp_fixture_enabled" {
  description = "Whether the API exposes the end-to-end MCP fixture."
  type        = bool
  default     = false
}

variable "platform_api_jwt_audience" {
  description = "JWT audience accepted by the API and agent-email API when the platform identity domain is not published."
  type        = string
  default     = ""
}

variable "platform_api_jwt_issuer" {
  description = "HTTPS JWT issuer accepted by the API and agent-email API when the platform identity domain is not published."
  type        = string
  default     = ""
}

variable "platform_api_reserved_concurrency" {
  description = "Reserved Lambda concurrency for the public API, or -1 for unreserved concurrency."
  type        = number
  default     = 100
}

variable "platform_api_route53_zone_id" {
  description = "Route 53 hosted zone containing platform_api_domain_name."
  type        = string
  default     = ""
}

variable "system_alarm_name_prefix" {
  description = "CloudWatch alarm name prefix the operator console lists; empty lists every alarm in the install's account and region."
  type        = string
  default     = ""
  nullable    = false
}

variable "model_credential_providers" {
  description = "Model providers whose key an organization owner or admin may store for the organization's own model calls: openai, openrouter, or both. List only providers whose gateway endpoint is the vendor's public API. Empty, the default, leaves the routes refusing every request and creates no KMS key."
  type        = list(string)
  default     = []
  nullable    = false

  validation {
    condition = (
      length(setsubtract(var.model_credential_providers, ["openai", "openrouter"])) == 0 &&
      length(distinct(var.model_credential_providers)) == length(var.model_credential_providers)
    )
    error_message = "model_credential_providers may list openai and openrouter, each at most once."
  }
}
