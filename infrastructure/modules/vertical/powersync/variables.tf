variable "name" { type = string }
variable "permissions_boundary_arn" {
  type    = string
  default = ""
}
variable "assign_public_ip" {
  type    = bool
  default = false
}
variable "cluster_arn" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "service_discovery_namespace_id" { type = string }
variable "image" {
  description = "Immutable PowerSync service image."
  type        = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.image))
    error_message = "image must be pinned by sha256 digest."
  }
}
variable "config_gzip_base64" {
  description = "Gzip-compressed, base64-encoded PowerSync YAML. It holds no credentials (database URIs come from !env), so it lives in the task definition and a rollback restores the matching configuration."
  type        = string
}
variable "config_version" {
  description = "Non-secret version marker, such as the database URL parameter versions, that forces a new task definition after a parameter update."
  type        = string
  default     = ""
}
variable "jwks_urls" {
  description = "Environment-variable names and trusted JWKS URLs referenced by the generated shared service configuration."
  type        = map(string)

  validation {
    condition = length(var.jwks_urls) > 0 && alltrue([
      for name, url in var.jwks_urls : can(regex("^PS_[A-Z0-9_]+_JWKS_URL$", name)) && can(regex("^https://", url))
    ])
    error_message = "jwks_urls must contain at least one PS_*_JWKS_URL key with an HTTPS value."
  }
}
variable "source_database_direct_secret_arn" {
  description = "SecureString parameter ARN containing the PowerSync source URL with explicit direct port 5432."
  type        = string
}
variable "storage_database_direct_secret_arn" {
  description = "SecureString parameter ARN containing the PowerSync storage URL with explicit direct port 5432."
  type        = string
}
variable "storage_transaction_connections" {
  description = "Reserved transaction connections for the PostgreSQL storage client."
  type        = number
  default     = 5

  validation {
    condition     = var.storage_transaction_connections >= 1 && var.storage_transaction_connections <= 5
    error_message = "storage_transaction_connections must be between 1 and 5."
  }
}
variable "direct_database_port" {
  description = "Direct PlanetScale PostgreSQL port used by both replication and storage URLs. PgBouncer port 6432 is forbidden."
  type        = number
  default     = 5432

  validation {
    condition     = var.direct_database_port == 5432
    error_message = "PowerSync source and storage connections must use direct PostgreSQL port 5432."
  }
}
variable "cpu" {
  type    = number
  default = 512
}
variable "memory" {
  type    = number
  default = 1024
}
variable "desired_count" {
  type    = number
  default = 1
}
variable "retain_task_definition_revisions" {
  description = "Retain replaced task definitions for administrator cleanup rather than granting global ECS deregistration."
  type        = bool
  default     = false
}
variable "wait_for_steady_state" {
  description = "Waits for the ECS deployment to become healthy before OpenTofu completes."
  type        = bool
  default     = false
}
variable "alb_health_check_path" {
  description = "HTTP readiness path used by the ALB target group."
  type        = string
  default     = "/probes/readiness"
}
variable "alb_listener_arn" {
  type    = string
  default = ""
}
variable "alb_security_group_id" {
  type    = string
  default = ""
}
variable "route_prefix" {
  type    = string
  default = "/powersync"
}
variable "route_priority" {
  type    = number
  default = 200
}
variable "tags" {
  type    = map(string)
  default = {}
}
