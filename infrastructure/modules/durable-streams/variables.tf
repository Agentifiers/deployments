variable "alarms_enabled" {
  description = "Whether the module creates its CloudWatch alarms. False creates none, for an installation whose ops alerts reach no one."
  type        = bool
  default     = true
}

variable "alarm_topic_arn" {
  description = "Ops alerts SNS topic ARN notified when an alarm enters or leaves the ALARM state."
  type        = string
}

variable "compact_task_sizing_enabled" {
  description = "Whether Durable Streams runs the compact task size (256 CPU / 512 MiB) instead of 1024 CPU / 2048 MiB."
  type        = bool
}

variable "fargate_spot_enabled" {
  description = "Whether Durable Streams runs on FARGATE_SPOT instead of FARGATE capacity."
  type        = bool
}

variable "container_insights_enabled" {
  description = "Whether ECS Container Insights is enabled on the Durable Streams cluster."
  type        = bool
}

variable "deletion_protection_enabled" {
  description = "Whether the private load balancer is protected from deletion."
  type        = bool
}

variable "desired_count" {
  description = "Durable Streams task count."
  type        = number
  default     = 0

  validation {
    condition     = floor(var.desired_count) == var.desired_count && var.desired_count >= 0 && var.desired_count <= 1
    error_message = "desired_count must be zero or one for the file-backed stream store."
  }
}

variable "environment" {
  description = "Platform environment name."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be a lowercase name of at most 16 characters."
  }
}

variable "file_system_deletion_protection_enabled" {
  description = "Whether the EFS stream store is retained with prevent_destroy. Changing this value moves the file system between protected and unprotected resource addresses."
  type        = bool
}

variable "image" {
  description = "Immutable Durable Streams image built from apps/durable-streams/Dockerfile."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.image))
    error_message = "image must be pinned by sha256 digest."
  }
}

variable "log_retention_in_days" {
  description = "CloudWatch log retention for the Durable Streams service log group."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a CloudWatch Logs retention value."
  }
}

variable "private_subnet_ids" {
  description = "Private subnet IDs used by Durable Streams and EFS."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "Durable Streams requires at least two private subnets."
  }
}

variable "secret_recovery_window_in_days" {
  description = "Secrets Manager recovery window."
  type        = number
  default     = 0
}

variable "shared_load_balancer" {
  description = "Optional existing private ALB used instead of provisioning a dedicated Durable Streams ALB."
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

variable "tags" {
  description = "Additional tags applied to Durable Streams resources."
  type        = map(string)
  default     = {}
}

variable "vpc_cidr" {
  description = "CIDR assigned to the shared platform VPC."
  type        = string
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
