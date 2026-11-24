variable "additional_environment" {
  description = "Extra Lambda environment variables for a replacement console build that reaches its own services. Keys starting with CONSOLE_ belong to this module and are refused."
  type        = map(string)
  default     = {}
  nullable    = false

  validation {
    condition     = alltrue([for key in keys(var.additional_environment) : !startswith(key, "CONSOLE_")])
    error_message = "additional_environment keys must not start with CONSOLE_, which the console module owns. Offending keys: ${join(", ", [for key in keys(var.additional_environment) : key if startswith(key, "CONSOLE_")])}."
  }
}

variable "additional_policy_json" {
  description = "IAM policy document attached to the console role as a separate inline policy, for a replacement console build that reaches its own services. The role's permissions boundary still applies. Null attaches none."
  type        = string
  default     = null

  validation {
    condition     = var.additional_policy_json == null || can(jsondecode(var.additional_policy_json))
    error_message = "additional_policy_json must be null or a JSON IAM policy document."
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

variable "application_origin" {
  description = "Public HTTPS origin that serves the console, for example https://app.example.com. Its host is the CloudFront alias."
  type        = string

  validation {
    condition = can(regex(
      "^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$",
      var.application_origin,
    ))
    error_message = "application_origin must be a lowercase https:// origin without a port, path, or trailing slash."
  }
}

variable "artifact_bucket" {
  description = "S3 bucket containing the console server Lambda artifact."
  type        = string

  validation {
    condition     = trimspace(var.artifact_bucket) != ""
    error_message = "artifact_bucket is required."
  }
}

variable "artifact_key" {
  description = "S3 key containing the console server Lambda artifact."
  type        = string

  validation {
    condition     = trimspace(var.artifact_key) != ""
    error_message = "artifact_key is required."
  }
}

variable "artifact_version" {
  description = "Immutable S3 object version of the console server Lambda artifact."
  type        = string

  validation {
    condition     = trimspace(var.artifact_version) != ""
    error_message = "artifact_version is required."
  }
}

variable "certificate_arn" {
  description = "Existing us-east-1 ACM certificate ARN covering the application origin host. When empty, the module issues a DNS-validated certificate in route53_zone_id."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.certificate_arn) == "" || can(regex("^arn:aws[a-z-]*:acm:us-east-1:[0-9]{12}:certificate/", var.certificate_arn))
    error_message = "certificate_arn must be empty or an ACM certificate ARN in us-east-1 (required by CloudFront)."
  }
}

variable "data_kms_key_arn" {
  description = "Shared platform data KMS key that seals BFF session and authorization transaction envelopes."
  type        = string
}

variable "deletion_protection_enabled" {
  description = "Whether the assets bucket refuses destruction while it holds objects."
  type        = bool
}

variable "detailed_metrics_enabled" {
  description = "Whether the console HTTP API publishes detailed per-route CloudWatch metrics."
  type        = bool
}

variable "environment" {
  description = "Deployment name used only for tags."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be a lowercase name of at most 16 characters."
  }
}

variable "identity_issuer" {
  description = "Platform identity issuer URL the console authenticates against."
  type        = string
}

variable "identity_table_arn" {
  description = "ARN of the identity table holding BFF authorization transactions, sessions, and identity fences."
  type        = string
}

variable "identity_table_name" {
  description = "Name of the identity table holding BFF authorization transactions, sessions, and identity fences."
  type        = string
}

variable "log_retention_in_days" {
  description = "Retention of the console Lambda and HTTP API access logs."
  type        = number
}

variable "oauth_callback_origin" {
  description = "Exact https origin of the channel/provider public API serving OAuth callbacks. The console shows the redirect URI to register with an OAuth provider from it; empty hides the origin."
  type        = string
  default     = ""
  nullable    = false

  validation {
    condition     = var.oauth_callback_origin == "" || can(regex("^https://[^/?#\\s]+$", var.oauth_callback_origin))
    error_message = "oauth_callback_origin must be empty or an https:// origin without a path or trailing slash."
  }
}

variable "stream_gateway_url" {
  description = "Exact https origin of the public stream gateway. The console shows it on the Integrate page; empty hides it."
  type        = string
  default     = ""
  nullable    = false

  validation {
    condition     = var.stream_gateway_url == "" || can(regex("^https://[^/?#\\s]+$", var.stream_gateway_url))
    error_message = "stream_gateway_url must be empty or an https:// origin without a path or trailing slash."
  }
}

variable "docs_origin" {
  description = "Exact https origin of the documentation site. The console links empty states and the Integrate page to it; empty hides those links."
  type        = string
  default     = ""
  nullable    = false

  validation {
    condition     = var.docs_origin == "" || can(regex("^https://[^/?#\\s]+$", var.docs_origin))
    error_message = "docs_origin must be empty or an https:// origin without a path or trailing slash."
  }
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}

variable "platform_api_url" {
  description = "Base URL of the platform API the console calls."
  type        = string

  validation {
    condition     = startswith(var.platform_api_url, "https://")
    error_message = "platform_api_url is required; the console needs the platform API (platform_api_enabled)."
  }
}

variable "route53_zone_id" {
  description = "Public Route 53 hosted zone containing the application origin host. When set, the module creates the certificate (unless certificate_arn is given) and the A/AAAA aliases; when empty, DNS is managed outside this stack."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Additional resource tags."
  type        = map(string)
  default     = {}
}

variable "web_client_secret_arn" {
  description = "Parameter Store ARN of the confidential deployments-web OAuth client secret."
  type        = string

  validation {
    condition     = startswith(var.web_client_secret_arn, "arn:")
    error_message = "web_client_secret_arn is required; the console needs platform identity (platform_identity_enabled)."
  }
}

variable "web_redirect_uris" {
  description = "Redirect URIs registered on the deployments-web OAuth client; must contain <application_origin>/auth/callback."
  type        = list(string)

  validation {
    condition     = contains(var.web_redirect_uris, "${var.application_origin}/auth/callback")
    error_message = "web_redirect_uris must contain <application_origin>/auth/callback for the console sign-in."
  }
}
