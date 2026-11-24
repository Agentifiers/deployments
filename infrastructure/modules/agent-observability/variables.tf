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
  description = "Maximum bytes one cold observability query may scan."
  type        = number
  default     = 10737418240
}

variable "destructive_cleanup_enabled" {
  description = "Whether the runtime buckets and Athena workgroups may be force-destroyed even while deletion_protection_enabled is true."
  type        = bool
  default     = false
}

variable "control_table_arn" {
  description = "Control table ARN used to fence quarantine writes during tenant erasure."
  type        = string
}

variable "control_table_name" {
  description = "Control table name used to fence quarantine writes during tenant erasure."
  type        = string
}

variable "deletion_protection_enabled" {
  description = "Whether the projector checkpoint table has DynamoDB deletion protection and the runtime buckets and Athena workgroups refuse force-destroy unless destructive_cleanup_enabled is set."
  type        = bool
}

variable "environment" {
  description = "Deployment environment name."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must start with a lowercase letter and contain at most 16 lowercase letters, digits, or hyphens."
  }
}

variable "execution_table_stream_arn" {
  description = "Execution table NEW_AND_OLD_IMAGES stream ARN."
  type        = string
}

variable "fact_stream_retention_hours" {
  description = "Kinesis observability fact-stream retention in hours."
  type        = number
  default     = 72

  validation {
    condition = (
      var.fact_stream_retention_hours >= 24 &&
      var.fact_stream_retention_hours <= 8760 &&
      floor(var.fact_stream_retention_hours) == var.fact_stream_retention_hours
    )
    error_message = "fact_stream_retention_hours must be a whole number from 24 through 8760."
  }
}

variable "history_retention_in_days" {
  description = "Days current and noncurrent objects stay in the Athena-result and Firehose backup buckets. The quarantine bucket always keeps 365 days."
  type        = number

  validation {
    condition     = floor(var.history_retention_in_days) == var.history_retention_in_days && var.history_retention_in_days >= 1
    error_message = "history_retention_in_days must be a positive whole number of days."
  }
}

variable "lambda_artifact_bucket" {
  description = "S3 bucket containing the immutable agent runtime artifact."
  type        = string
}

variable "lambda_artifact_key" {
  description = "S3 key containing the immutable agent runtime artifact."
  type        = string
}

variable "lambda_artifact_version" {
  description = "Immutable S3 object version for the agent runtime artifact."
  type        = string
}

variable "log_retention_in_days" {
  description = "CloudWatch log retention for the Firehose, normalizer, projector, and erasure log groups."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a CloudWatch Logs retention value."
  }
}

variable "point_in_time_recovery_enabled" {
  description = "Whether DynamoDB point-in-time recovery is enabled on the projector checkpoint table."
  type        = bool
}

variable "s3_table_arns" {
  description = "Agent observability Iceberg table ARNs by fact family."
  type        = map(string)
}

variable "s3_table_bucket_arn" {
  description = "ARN of the S3 Tables bucket containing observability history."
  type        = string
}

variable "s3_table_bucket_name" {
  description = "Name of the S3 Tables bucket containing observability history."
  type        = string
}

variable "s3_table_names" {
  description = "Agent observability Iceberg table names by fact family."
  type        = map(string)
}

variable "s3_table_namespace" {
  description = "S3 Tables namespace containing observability history."
  type        = string
}

variable "s3tables_catalog_arn" {
  description = "Account-level Glue S3 Tables catalog ARN."
  type        = string
}

variable "s3tables_catalog_name" {
  description = "Account-level Glue S3 Tables catalog name."
  type        = string
}

variable "tags" {
  description = "Additional tags applied to every resource."
  type        = map(string)
  default     = {}
}

variable "usage_table_stream_arn" {
  description = "Usage table NEW_AND_OLD_IMAGES stream ARN."
  type        = string
}

variable "clickhouse_backup_expiry_days" {
  description = "Days after which native ClickHouse backups and EBS snapshots of the hot plane are deleted; zero when no hot plane is deployed."
  type = object({
    ebs_snapshot  = number
    native_backup = number
  })
  default = {
    ebs_snapshot  = 0
    native_backup = 0
  }
}

variable "hot_plane_base_url" {
  description = "Private observability hot-plane API URL, or empty when the hot plane is not deployed."
  type        = string
  default     = ""
}

variable "hot_plane_secret_arn" {
  description = "SSM SecureString parameter ARN containing the internal hot-plane service token, or empty."
  type        = string
  default     = ""
}

variable "physical_removal" {
  description = "Pinned S3 Tables maintenance settings that bound physical removal of erased Iceberg rows."
  type = object({
    noncurrent_file_days   = number
    snapshot_max_age_hours = number
    unreferenced_file_days = number
  })
}

variable "network" {
  description = "Platform VPC hosting the private hot plane and the private subnets the erasure Lambda runs in, or null when no platform VPC exists."
  type = object({
    private_subnet_ids = list(string)
    vpc_id             = string
  })
  default = null
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}
