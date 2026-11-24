variable "alarms_enabled" {
  description = "Whether the module creates its CloudWatch alarms. False creates none, for an installation whose ops alerts reach no one."
  type        = bool
  default     = true
}

variable "alarm_topic_arn" {
  description = "Ops alerts SNS topic ARN notified when an alarm enters or leaves the ALARM state."
  type        = string
}

variable "allowed_origins" {
  description = "Browser origins allowed to read thread streams cross-origin, for example https://app.example.com. An entry https://*.<domain> admits one DNS label in place of the *. Empty disables CORS."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for origin in var.allowed_origins :
      can(regex("^https://(\\*\\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", origin))
    ])
    error_message = "allowed_origins must contain lowercase https:// origins, optionally with a leading *. label, without a port, path, or trailing slash."
  }
}

variable "compact_task_sizing_enabled" {
  description = "Whether the gateway runs the compact task size (256 CPU / 512 MiB) instead of 512 CPU / 1024 MiB."
  type        = bool
}

variable "container_insights_enabled" {
  description = "Whether ECS Container Insights is enabled on the stream gateway cluster."
  type        = bool
}

variable "deletion_protection_enabled" {
  description = "Whether the dedicated public load balancer is protected from deletion. Unused with shared_load_balancer."
  type        = bool
}

variable "domain_name" {
  description = "Public hostname served by the stream gateway."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", var.domain_name))
    error_message = "domain_name must be a lowercase DNS hostname."
  }
}

variable "fargate_spot_enabled" {
  description = "Whether the gateway runs on FARGATE_SPOT instead of FARGATE capacity."
  type        = bool
}

variable "durable_streams_auth_secret_arn" {
  description = "SSM SecureString parameter ARN containing the internal Durable Streams auth token."
  type        = string
}

variable "durable_streams_base_url" {
  description = "Private Durable Streams base URL."
  type        = string
}

variable "durable_streams_load_balancer_security_group_id" {
  description = "Security group of the internal load balancer fronting Durable Streams."
  type        = string
}

variable "environment" {
  description = "Deployment name used only for resource naming and tags."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be a lowercase name of at most 16 characters."
  }
}

variable "high_availability_enabled" {
  description = "Whether the gateway runs two tasks across availability zones instead of one."
  type        = bool
}

variable "image" {
  description = "Immutable stream gateway image built from apps/stream-gateway."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.image))
    error_message = "image must be pinned by sha256 digest."
  }
}

variable "log_retention_in_days" {
  description = "CloudWatch log retention for the stream gateway service log group."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a CloudWatch Logs retention period."
  }
}

variable "private_subnet_ids" {
  description = "Private subnet IDs used by stream gateway tasks."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "The stream gateway requires at least two private subnets."
  }
}

variable "public_subnet_ids" {
  description = "Public subnet IDs used by the dedicated internet-facing load balancer. Unused with shared_load_balancer."
  type        = list(string)

  validation {
    condition     = length(var.public_subnet_ids) >= 2
    error_message = "The stream gateway requires at least two public subnets."
  }
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone containing domain_name."
  type        = string
}

variable "shared_load_balancer" {
  description = "Existing internal ALB that serves the gateway through a CloudFront VPC origin instead of a dedicated internet-facing ALB. Null provisions the dedicated ALB."
  type = object({
    arn               = string
    arn_suffix        = string
    dns_name          = string
    security_group_id = string
  })
  default  = null
  nullable = true

  validation {
    condition = var.shared_load_balancer == null || try(
      can(regex("^arn:[^:]+:elasticloadbalancing:[^:]+:[0-9]{12}:loadbalancer/app/.+$", var.shared_load_balancer.arn)) &&
      can(regex("^sg-[0-9a-f]+$", var.shared_load_balancer.security_group_id)),
      false,
    )
    error_message = "shared_load_balancer must identify an application load balancer and its security group."
  }
}

variable "stream_session_secret_arn" {
  description = "SSM SecureString parameter ARN containing the stream session signing key."
  type        = string
}

variable "tags" {
  description = "Additional tags applied to stream gateway resources."
  type        = map(string)
  default     = {}
}

variable "vpc_id" {
  description = "Shared platform VPC ID."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}
