variable "alarms_enabled" {
  description = "Whether the module creates its CloudWatch alarms. False creates none, for an installation whose ops alerts reach no one."
  type        = bool
  default     = true
}

variable "alarm_topic_arn" {
  description = "Ops alerts SNS topic ARN notified when an alarm enters or leaves the ALARM state."
  type        = string
}

variable "athena_bytes_scanned_cutoff" {
  description = "Maximum bytes one Athena event query may scan."
  type        = number
  default     = 10737418240

  validation {
    condition     = var.athena_bytes_scanned_cutoff >= 10485760
    error_message = "athena_bytes_scanned_cutoff must be at least 10 MiB."
  }
}

variable "destructive_cleanup_enabled" {
  description = "Whether runtime failure buckets, Athena results, and workgroup history are prepared for a later destructive OpenTofu apply, even while storage_deletion_protection_enabled is true."
  type        = bool
  default     = false
}

variable "environment" {
  description = "Platform environment name."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must start with a lowercase letter and contain at most 16 lowercase letters, digits, or hyphens."
  }
}

variable "event_bus_name" {
  description = "Name of the semantic EventBridge bus."
  type        = string

  validation {
    condition     = trimspace(var.event_bus_name) != ""
    error_message = "event_bus_name is required."
  }
}

variable "extra_event_sources" {
  description = "EventBridge sources recorded in addition to deployments-ai.platform. Their events must use the canonical semantic event shape."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for source in var.extra_event_sources : trimspace(source) != ""])
    error_message = "extra_event_sources must not contain an empty source."
  }
}

variable "failure_retention_in_days" {
  description = "Days current and noncurrent objects stay in the Firehose failure backup bucket."
  type        = number

  validation {
    condition     = floor(var.failure_retention_in_days) == var.failure_retention_in_days && var.failure_retention_in_days >= 1
    error_message = "failure_retention_in_days must be a positive whole number of days."
  }
}

variable "log_retention_in_days" {
  description = "CloudWatch log retention for the Firehose and projector log groups."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a CloudWatch Logs retention value."
  }
}

variable "projector_enabled" {
  description = "Whether the EventBridge rule sends new semantic events to the analytical projector."
  type        = bool
  default     = true
}

variable "projector_artifact_bucket" {
  description = "S3 bucket containing the bundled event analytics projector Lambda artifact."
  type        = string

  validation {
    condition     = trimspace(var.projector_artifact_bucket) != ""
    error_message = "projector_artifact_bucket is required."
  }
}

variable "projector_artifact_key" {
  description = "S3 object key for the bundled event analytics projector Lambda artifact."
  type        = string

  validation {
    condition     = trimspace(var.projector_artifact_key) != ""
    error_message = "projector_artifact_key is required."
  }
}

variable "projector_artifact_version" {
  description = "Immutable S3 object version for the event analytics projector Lambda artifact."
  type        = string

  validation {
    condition = (
      trimspace(var.projector_artifact_version) != "" &&
      lower(trimspace(var.projector_artifact_version)) != "null"
    )
    error_message = "projector_artifact_version must be a non-null immutable S3 object version."
  }
}

variable "query_result_retention_in_days" {
  description = "Days current and noncurrent objects stay in the Athena query-result bucket."
  type        = number

  validation {
    condition     = floor(var.query_result_retention_in_days) == var.query_result_retention_in_days && var.query_result_retention_in_days >= 1
    error_message = "query_result_retention_in_days must be a positive whole number of days."
  }
}

variable "s3_table_arn" {
  description = "ARN of the durable semantic event Iceberg table owned by platform data."
  type        = string

  validation {
    condition     = trimspace(var.s3_table_arn) != ""
    error_message = "s3_table_arn is required."
  }
}

variable "s3_table_bucket_arn" {
  description = "ARN of the S3 Tables bucket containing semantic event history."
  type        = string

  validation {
    condition     = trimspace(var.s3_table_bucket_arn) != ""
    error_message = "s3_table_bucket_arn is required."
  }
}

variable "s3_table_bucket_name" {
  description = "Name of the S3 Tables bucket containing semantic event history."
  type        = string

  validation {
    condition     = trimspace(var.s3_table_bucket_name) != ""
    error_message = "s3_table_bucket_name is required."
  }
}

variable "s3_table_name" {
  description = "Name of the semantic event Iceberg table."
  type        = string

  validation {
    condition     = trimspace(var.s3_table_name) != ""
    error_message = "s3_table_name is required."
  }
}

variable "s3_table_namespace" {
  description = "Namespace containing the semantic event Iceberg table."
  type        = string

  validation {
    condition     = trimspace(var.s3_table_namespace) != ""
    error_message = "s3_table_namespace is required."
  }
}

variable "s3tables_catalog_arn" {
  description = "ARN of the account-level Glue S3 Tables catalog integration."
  type        = string

  validation {
    condition     = trimspace(var.s3tables_catalog_arn) != ""
    error_message = "s3tables_catalog_arn is required."
  }
}

variable "s3tables_catalog_name" {
  description = "Name of the account-level Glue S3 Tables catalog integration."
  type        = string

  validation {
    condition     = trimspace(var.s3tables_catalog_name) != ""
    error_message = "s3tables_catalog_name is required."
  }
}

variable "storage_deletion_protection_enabled" {
  description = "Whether the failure backup and Athena query-result buckets and the Athena workgroup refuse force-destroy unless destructive_cleanup_enabled is set."
  type        = bool
}

variable "tags" {
  description = "Additional tags applied to event analytics resources."
  type        = map(string)
  default     = {}
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}
