variable "additional_clients" {
  description = "Confidential OAuth clients the install operator declares for its own services, keyed by client ID. The client bootstrap registers each for the authorization code flow with refresh and PKCE, requires openid, and writes its secret to the SSM SecureString /identity/<client ID>-oauth-client."
  type = map(object({
    allowed_scopes = list(string)
    name           = string
    redirect_uris  = list(string)
  }))
  default  = {}
  nullable = false
  validation {
    condition = alltrue([
      for id in keys(var.additional_clients) :
      can(regex("^[a-z][a-z0-9-]{0,62}[a-z0-9]$", id)) &&
      !startswith(id, "deployments-") && !startswith(id, "apps-") && !contains(["e2e", "web"], id)
    ])
    error_message = "additional_clients keys must be 2 to 64 lowercase letters, digits, or hyphens that start with a letter and end with a letter or digit. They cannot start with deployments- or apps- or be web or e2e, which name the built-in clients and their secret parameters."
  }
  validation {
    condition     = alltrue([for client in values(var.additional_clients) : trimspace(client.name) != ""])
    error_message = "additional_clients name must not be empty."
  }
  validation {
    condition = alltrue([
      for client in values(var.additional_clients) :
      length(client.redirect_uris) > 0 && alltrue([
        for uri in client.redirect_uris : can(regex("^https://[^/?#@[:space:]]+(/[^#[:space:]]*)?$", uri))
      ])
    ])
    error_message = "additional_clients redirect_uris must list at least one HTTPS URL without a user name, password, or fragment."
  }
  validation {
    condition     = alltrue([for client in values(var.additional_clients) : contains(client.allowed_scopes, "openid")])
    error_message = "additional_clients allowed_scopes must include openid, because every declared client signs people in with OpenID Connect."
  }
}
variable "alarms_enabled" {
  description = "Whether the module creates its CloudWatch alarms. False creates none, for an installation whose ops alerts reach no one."
  type        = bool
  default     = true
}

variable "alarm_topic_arn" {
  description = "Ops alerts SNS topic ARN notified when an alarm enters or leaves the ALARM state."
  type        = string
}
variable "api_artifact_bucket" { type = string }
variable "api_artifact_key" { type = string }
variable "api_artifact_version" { type = string }
variable "api_reserved_concurrency" {
  type    = number
  default = null
}
variable "application_origin" { type = string }
variable "certificate_arn" {
  type    = string
  default = ""
}
variable "cli_redirect_uris" { type = list(string) }
variable "control_table_arn" { type = string }
variable "control_table_name" { type = string }
variable "data_kms_key_arn" {
  description = "Shared platform data KMS key that seals identity email payload envelopes."
  type        = string
}
variable "deletion_protection_enabled" {
  description = "Whether the signing and federation KMS keys use their retained (prevent_destroy) variants."
  type        = bool
}
variable "deploying_role_name" {
  description = "Name of the IAM role in this account that runs deployments. It alone may assume the OAuth client bootstrap role."
  type        = string
  validation {
    condition     = can(regex("^[A-Za-z0-9+=,.@_-]{1,64}$", var.deploying_role_name))
    error_message = "deploying_role_name must be an IAM role name without a path."
  }
}
variable "detailed_metrics_enabled" {
  description = "Whether API Gateway detailed CloudWatch metrics are enabled for every identity API method."
  type        = bool
}
variable "domain_name" { type = string }
variable "email_artifact_bucket" { type = string }
variable "email_artifact_key" { type = string }
variable "email_artifact_version" { type = string }
variable "email_sender" {
  type = string
  validation {
    condition     = can(regex("^[^@[:space:]]+@[^@[:space:]]+$", trimspace(var.email_sender)))
    error_message = "email_sender must be a valid mailbox address."
  }
}
variable "e2e_client_enabled" {
  description = "Whether the client bootstrap seeds the confidential OAuth client used by credentialed end-to-end tests."
  type        = bool
}
variable "environment" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be a lowercase name of at most 16 characters."
  }
}
variable "events_table_arn" { type = string }
variable "events_table_name" { type = string }
variable "human_verification" {
  description = "Siteverify-compatible challenge required on self-service sign-up and password recovery. The secret is an SSM SecureString named by secret_parameter_name and encrypted with the aws/ssm key. Null requires no challenge."
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
  validation {
    condition = var.human_verification == null ? true : alltrue([
      for url in [var.human_verification.script_url, var.human_verification.verify_url] : try(
        length(regexall("^https://([a-z0-9-]+\\.)*[a-z][a-z0-9-]*(:[0-9]{1,5})?([/?#][^\\s]*)?$", url)) == 1
        && length(regexall("^https://([a-z0-9-]+\\.)*xn--", url)) == 0
        && alltrue([for port in regexall("^https://[^/?#]*:([0-9]+)", url) : tonumber(port[0]) <= 65535]),
        false
      )
    ])
    error_message = "human_verification script_url and verify_url must be HTTPS URLs whose host is a lowercase DNS name without xn-- labels or a numeric last label, with no user name or password and a port of at most 65535."
  }
  validation {
    condition     = var.human_verification == null ? true : can(regex("^/?[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$", var.human_verification.secret_parameter_name))
    error_message = "human_verification secret_parameter_name must be an SSM parameter name, such as /identity/human-verification-secret, not an ARN."
  }
  validation {
    condition     = var.human_verification == null ? true : can(regex("^[A-Za-z0-9_.-]{1,256}$", var.human_verification.site_key))
    error_message = "human_verification site_key must be 1 to 256 letters, digits, periods, hyphens, or underscores."
  }
  validation {
    condition = var.human_verification == null ? true : alltrue([
      for name in [var.human_verification.widget_class, var.human_verification.response_field] :
      can(regex("^[A-Za-z][A-Za-z0-9_-]{0,63}$", name))
    ])
    error_message = "human_verification widget_class and response_field must start with a letter and be at most 64 letters, digits, hyphens, or underscores."
  }
  validation {
    condition = var.human_verification == null ? true : alltrue([
      for origin in var.human_verification.widget_origins : can(regex("^https://(\\*\\.)?[a-z0-9-]+(\\.[a-z0-9-]+)*(:[0-9]{1,5})?$", origin))
    ])
    error_message = "human_verification widget_origins entries must be HTTPS origins with a lowercase host, an optional leading *. wildcard, and an optional port of at most 5 digits."
  }
}
variable "identity_email_stream_arn" { type = string }
variable "identity_email_table_arn" { type = string }
variable "identity_email_table_name" { type = string }
variable "identity_table_arn" { type = string }
variable "identity_table_name" { type = string }
variable "kms_deletion_window_in_days" {
  description = "Waiting period before the unprotected signing and federation KMS keys can be deleted; the protected variants always use 30 days."
  type        = number
  validation {
    condition     = var.kms_deletion_window_in_days >= 7 && var.kms_deletion_window_in_days <= 30 && floor(var.kms_deletion_window_in_days) == var.kms_deletion_window_in_days
    error_message = "kms_deletion_window_in_days must be a whole number from 7 to 30."
  }
}
variable "log_retention_in_days" {
  description = "CloudWatch retention for the identity Lambda log groups."
  type        = number
  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a CloudWatch Logs retention value."
  }
}
variable "publish_domain" {
  type    = bool
  default = false
}
variable "registration_enabled" {
  type    = bool
  default = false
}
variable "resource_audience" { type = string }
variable "route53_zone_id" {
  type    = string
  default = ""
}
variable "signing_kid" {
  type    = string
  default = "identity-rs256-v1"
}
variable "tags" {
  type    = map(string)
  default = {}
}
variable "waf_rate_limit" {
  type    = number
  default = 1000
}
variable "web_application_firewall_enabled" {
  description = "Whether a regional WAFv2 web ACL with managed common rules and a coarse per-IP rate limit protects the identity REST API stage."
  type        = bool
}
variable "web_redirect_uris" { type = list(string) }
variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}
