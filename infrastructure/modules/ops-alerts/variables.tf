variable "alert_email" {
  description = "Address subscribed to the ops alerts topic by email. Empty subscribes no address."
  type        = string
}

variable "environment" {
  description = "Platform environment name."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be a lowercase name of at most 16 characters."
  }
}

variable "kms_key_arn" {
  description = "Shared platform data key that encrypts the ops alerts topic. Its key policy must admit CloudWatch publishing to the topic."
  type        = string
}

variable "log_retention_in_days" {
  description = "CloudWatch retention for the notifier Lambda log group."
  type        = number
}

variable "notifier_artifact_bucket" {
  description = "S3 bucket containing the ops alerts notifier Lambda artifact."
  type        = string
}

variable "notifier_artifact_key" {
  description = "S3 object key for the ops alerts notifier Lambda artifact."
  type        = string
}

variable "notifier_artifact_version" {
  description = "Immutable S3 object version for the ops alerts notifier Lambda artifact."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}

variable "slack_channel_id" {
  description = "Slack channel ID the notifier posts alarms to. Empty leaves Slack delivery unconfigured."
  type        = string
}

variable "tags" {
  description = "Additional tags applied to ops alerting resources."
  type        = map(string)
  default     = {}
}
