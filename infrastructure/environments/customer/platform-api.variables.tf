variable "platform_api_enabled" {
  description = "Whether to deploy the unified public product API."
  type        = bool
  default     = true

  validation {
    condition = (
      !var.platform_api_enabled ||
      (
        var.agent_runtime_enabled &&
        var.channel_provider_runtime_enabled &&
        var.memory_runtime_enabled
      )
    )
    error_message = "agent_runtime_enabled, channel_provider_runtime_enabled, and memory_runtime_enabled must all be true when platform_api_enabled is true."
  }
}

variable "platform_api_artifact_bucket" {
  description = "S3 bucket containing the bundled functions/api Lambda artifact."
  type        = string
  default     = ""

  validation {
    condition     = !var.platform_api_enabled || trimspace(var.platform_api_artifact_bucket) != ""
    error_message = "platform_api_artifact_bucket is required when platform_api_enabled is true."
  }
}

variable "platform_api_artifact_key" {
  description = "S3 key containing the bundled functions/api Lambda artifact."
  type        = string
  default     = ""

  validation {
    condition     = !var.platform_api_enabled || trimspace(var.platform_api_artifact_key) != ""
    error_message = "platform_api_artifact_key is required when platform_api_enabled is true."
  }
}

variable "platform_api_artifact_version" {
  description = "Immutable S3 object version for the bundled functions/api Lambda artifact."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.platform_api_enabled ||
      (
        trimspace(var.platform_api_artifact_version) != "" &&
        lower(trimspace(var.platform_api_artifact_version)) != "null"
      )
    )
    error_message = "A non-null platform_api_artifact_version is required when platform_api_enabled is true."
  }
}

variable "platform_api_certificate_arn" {
  description = "ACM certificate ARN for platform_api_domain_name."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.platform_api_enabled ||
      can(regex("^arn:aws[a-z-]*:acm:[^:]+:[0-9]{12}:certificate/", trimspace(var.platform_api_certificate_arn)))
    )
    error_message = "platform_api_certificate_arn must be a valid ACM certificate ARN when platform_api_enabled is true."
  }
}

variable "platform_api_domain_name" {
  description = "Hostname of the public product API, such as api.example.com. Its HTTPS URL is the identity resource audience."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", var.platform_api_domain_name))
    error_message = "platform_api_domain_name must be a lowercase DNS hostname."
  }
}

variable "platform_api_device_authorization_client_id" {
  description = "RFC 8628 OAuth client ID; configure with the device issuer and use the platform JWT audience."
  type        = string
  default     = ""
}

variable "platform_api_device_authorization_issuer" {
  description = "OIDC issuer advertising RFC 8628 endpoints; configure with the device client and use the platform JWT issuer."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.platform_api_device_authorization_issuer) == "" ||
      can(regex("^https://[^/[:space:]]+", trimspace(var.platform_api_device_authorization_issuer)))
    )
    error_message = "platform_api_device_authorization_issuer must be empty or an HTTPS issuer URL."
  }
}

variable "platform_api_route53_zone_id" {
  description = "Route 53 hosted zone containing platform_api_domain_name."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.platform_api_enabled ||
      trimspace(var.platform_api_route53_zone_id) != ""
    )
    error_message = "platform_api_route53_zone_id is required when platform_api_enabled is true."
  }
}
