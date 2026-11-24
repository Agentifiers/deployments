variable "apps_enabled" {
  description = "Whether to create the agent-built apps runtime. Enabling it also creates the shared private network. It needs the platform identity provider and the model runtime's shared internal load balancer."
  type        = bool
  default     = false
}

variable "apps_domain" {
  description = "Domain whose subdomains serve agent-built apps, one <slug>.<apps_domain> host per app."
  type        = string
  default     = ""

  validation {
    condition     = !var.apps_enabled || can(regex("^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,63}$", var.apps_domain))
    error_message = "Set apps_domain to a lowercase DNS name when apps_enabled is true."
  }
}

variable "apps_route53_zone_id" {
  description = "Route 53 zone that holds apps_domain."
  type        = string
  default     = ""

  validation {
    condition     = !var.apps_enabled || trimspace(var.apps_route53_zone_id) != ""
    error_message = "apps_route53_zone_id is required when apps_enabled is true."
  }
}

variable "app_gateway_image" {
  description = "Digest-pinned image built from apps/app-gateway/Dockerfile."
  type        = string
  default     = ""
}

variable "apps_database_artifact_bucket" {
  description = "S3 bucket containing the apps-database Lambda bundle."
  type        = string
  default     = ""

  validation {
    condition     = !var.apps_enabled || trimspace(var.apps_database_artifact_bucket) != ""
    error_message = "apps_database_artifact_bucket is required when apps_enabled is true."
  }
}

variable "apps_database_artifact_key" {
  description = "S3 key of the apps-database Lambda bundle."
  type        = string
  default     = ""

  validation {
    condition     = !var.apps_enabled || trimspace(var.apps_database_artifact_key) != ""
    error_message = "apps_database_artifact_key is required when apps_enabled is true."
  }
}

variable "apps_database_artifact_version" {
  description = "Immutable S3 object version of the apps-database Lambda bundle."
  type        = string
  default     = ""

  validation {
    condition     = !var.apps_enabled || trimspace(var.apps_database_artifact_version) != ""
    error_message = "apps_database_artifact_version is required when apps_enabled is true."
  }
}

variable "app_domains_artifact_bucket" {
  description = "S3 bucket containing the apps-domains Lambda bundle."
  type        = string
  default     = ""

  validation {
    condition     = !var.apps_enabled || trimspace(var.app_domains_artifact_bucket) != ""
    error_message = "app_domains_artifact_bucket is required when apps_enabled is true."
  }
}

variable "app_domains_artifact_key" {
  description = "S3 key of the apps-domains Lambda bundle."
  type        = string
  default     = ""

  validation {
    condition     = !var.apps_enabled || trimspace(var.app_domains_artifact_key) != ""
    error_message = "app_domains_artifact_key is required when apps_enabled is true."
  }
}

variable "app_domains_artifact_version" {
  description = "Immutable S3 object version of the apps-domains Lambda bundle."
  type        = string
  default     = ""

  validation {
    condition     = !var.apps_enabled || trimspace(var.app_domains_artifact_version) != ""
    error_message = "app_domains_artifact_version is required when apps_enabled is true."
  }
}
