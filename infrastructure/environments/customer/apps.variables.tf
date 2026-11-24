variable "apps_enabled" {
  description = "Whether to run agent-built apps: an Aurora PostgreSQL Serverless v2 cluster, the app gateway, and one <slug>.<apps_domain> host per app. Off by default because it serves untrusted, agent-written code on a domain you choose."
  type        = bool
  default     = false

  validation {
    condition     = !var.apps_enabled || var.agent_runtime_enabled
    error_message = "apps_enabled requires agent_runtime_enabled."
  }
}

variable "apps_domain" {
  description = "Domain whose subdomains serve agent-built apps, such as apps.example.com. Required when apps_enabled is true."
  type        = string
  default     = ""
  nullable    = false
}

variable "apps_route53_zone_id" {
  description = "Public Route 53 hosted zone that contains apps_domain. Required when apps_enabled is true."
  type        = string
  default     = ""
  nullable    = false
}

variable "app_gateway_image" {
  description = "Digest-pinned app-gateway image; set by the deploy tool."
  type        = string
  default     = ""
  nullable    = false
}

variable "apps_database_artifact_bucket" {
  description = "S3 bucket containing the apps-database Lambda bundle; the deploy pipeline sets it."
  type        = string
  default     = ""
}

variable "apps_database_artifact_key" {
  description = "S3 key of the apps-database Lambda bundle; the deploy pipeline sets it."
  type        = string
  default     = ""
}

variable "apps_database_artifact_version" {
  description = "Immutable S3 object version of the apps-database Lambda bundle; the deploy pipeline sets it."
  type        = string
  default     = ""
}

variable "app_domains_artifact_bucket" {
  description = "S3 bucket containing the apps-domains Lambda bundle; the deploy pipeline sets it."
  type        = string
  default     = ""
}

variable "app_domains_artifact_key" {
  description = "S3 key of the apps-domains Lambda bundle; the deploy pipeline sets it."
  type        = string
  default     = ""
}

variable "app_domains_artifact_version" {
  description = "Immutable S3 object version of the apps-domains Lambda bundle; the deploy pipeline sets it."
  type        = string
  default     = ""
}
