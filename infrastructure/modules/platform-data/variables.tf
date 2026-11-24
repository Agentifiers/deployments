variable "deletion_protection_enabled" {
  description = "Whether data stores are protected from deletion: DynamoDB deletion protection, retained (prevent_destroy) KMS key, bucket, catalog, and table variants, and no force_destroy on table buckets."
  type        = bool
}

variable "agent_observability_history_enabled" {
  description = "Whether to provision the separately authorized Phase 2 observability cold-history tables."
  type        = bool
  default     = false
}

variable "agent_observability_snapshot_max_age_hours" {
  description = "S3 Tables snapshot expiry age for observability history; bounds physical removal after tenant erasure."
  type        = number
  default     = 72

  validation {
    condition     = var.agent_observability_snapshot_max_age_hours >= 1 && floor(var.agent_observability_snapshot_max_age_hours) == var.agent_observability_snapshot_max_age_hours
    error_message = "agent_observability_snapshot_max_age_hours must be a positive whole number."
  }
}

variable "agent_observability_unreferenced_file_days" {
  description = "Days before S3 Tables marks unreferenced observability data files noncurrent."
  type        = number
  default     = 3

  validation {
    condition     = var.agent_observability_unreferenced_file_days >= 1 && floor(var.agent_observability_unreferenced_file_days) == var.agent_observability_unreferenced_file_days
    error_message = "agent_observability_unreferenced_file_days must be a positive whole number."
  }
}

variable "agent_observability_noncurrent_file_days" {
  description = "Days before S3 Tables permanently deletes noncurrent observability data files."
  type        = number
  default     = 3

  validation {
    condition     = var.agent_observability_noncurrent_file_days >= 1 && floor(var.agent_observability_noncurrent_file_days) == var.agent_observability_noncurrent_file_days
    error_message = "agent_observability_noncurrent_file_days must be a positive whole number."
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

variable "ingress_attachment_capture_principal_arns" {
  description = "Ingress Lambda roles that may assume the attachment capture role, always with organizationId, projectId, and environmentId session tags. No role is created while the list is empty."
  type        = list(string)
  default     = []
}

variable "kms_deletion_window_in_days" {
  description = "Waiting period before the shared platform data KMS key and governance signing key can be deleted."
  type        = number
  default     = 30
}

variable "sns_service_publishers" {
  description = "AWS service principals allowed to publish to SNS topics encrypted with the shared data key, keyed by key policy statement ID. Topic names resolve in this account and region."
  type = map(object({
    service     = string
    topic_names = list(string)
  }))
  default = {}
}

variable "tags" {
  description = "Additional tags applied to every resource."
  type        = map(string)
  default     = {}
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

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}
