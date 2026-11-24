variable "alarms_enabled" {
  description = "Whether the module creates its CloudWatch alarms. False creates none, for an installation whose ops alerts reach no one."
  type        = bool
  default     = true
}

variable "alarm_topic_arn" {
  description = "Ops alerts SNS topic ARN notified when an alarm enters or leaves the ALARM state."
  type        = string
}

variable "archive_retention_days" {
  description = "Retention for the EventBridge semantic event archive."
  type        = number
  default     = 30
}

variable "dispatcher_artifact_bucket" {
  description = "S3 bucket containing the bundled event dispatcher Lambda artifact."
  type        = string
}

variable "dispatcher_artifact_key" {
  description = "S3 object key for the bundled event dispatcher Lambda artifact."
  type        = string
}

variable "dispatcher_artifact_version" {
  description = "Immutable S3 object version for the bundled event dispatcher Lambda artifact."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = try(
      trimspace(var.dispatcher_artifact_version) != "" &&
      lower(trimspace(var.dispatcher_artifact_version)) != "null",
      false,
    )
    error_message = "dispatcher_artifact_version must pin a non-null immutable S3 object version."
  }
}

variable "deletion_protection_enabled" {
  description = "Whether the dispatcher failure bucket is protected from force_destroy."
  type        = bool
}

variable "environment" {
  description = "Platform environment name."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be a lowercase name of at most 16 characters."
  }
}

variable "events_stream_arn" {
  description = "DynamoDB Stream ARN for the semantic events table."
  type        = string
}

variable "failure_retention_in_days" {
  description = "Days before dispatcher failure payloads (current and noncurrent versions) expire."
  type        = number

  validation {
    condition     = var.failure_retention_in_days >= 1 && floor(var.failure_retention_in_days) == var.failure_retention_in_days
    error_message = "failure_retention_in_days must be a positive whole number."
  }
}

variable "log_retention_in_days" {
  description = "CloudWatch retention for the event dispatcher Lambda log group."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a CloudWatch Logs retention value."
  }
}

variable "tags" {
  description = "Additional tags applied to eventing resources."
  type        = map(string)
  default     = {}
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}
