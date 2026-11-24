variable "agent_run_queue_arn" {
  description = "FIFO agent-run queue ARN."
  type        = string
}

variable "agent_run_queue_url" {
  description = "FIFO agent-run queue URL."
  type        = string
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

variable "artifact_bucket" {
  description = "S3 bucket containing the bundled inbound Lambda artifact."
  type        = string
}

variable "artifact_key" {
  description = "S3 key containing the bundled inbound Lambda artifact."
  type        = string
}

variable "artifact_version" {
  description = "Immutable S3 object version for the inbound Lambda artifact."
  type        = string
}

variable "channel_ingress_queue_arn" {
  description = "Normalized channel ingress queue ARN."
  type        = string
}

variable "control_table_arn" {
  description = "Control table ARN."
  type        = string
}

variable "control_table_name" {
  description = "Control table name."
  type        = string
}

variable "credential_vault_reader_role_arn" {
  description = "Tenant-scoped credential-vault reader role the flush assumes to read a binding's provider credential."
  type        = string
}

variable "data_kms_key_arn" {
  description = "Shared KMS key that encrypts platform artifact objects and the credential vault."
  type        = string
}

variable "document_extraction_function" {
  description = "Document extraction Lambda (arn, function_name) the flush invokes to read the text of captured documents."
  type = object({
    arn           = string
    function_name = string
  })
}

variable "end_user_subject_key_arn" {
  description = "SSM SecureString parameter ARN of the end-user subject HMAC key."
  type        = string
}
variable "environment" {
  description = "Platform environment."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be a lowercase name of at most 16 characters."
  }
}

variable "events_table_arn" {
  description = "Events table ARN."
  type        = string
}

variable "events_table_name" {
  description = "Events table name."
  type        = string
}

variable "execution_table_arn" {
  description = "Execution table ARN."
  type        = string
}

variable "execution_table_name" {
  description = "Execution table name."
  type        = string
}

variable "ingress_attachment_capture_role_arn" {
  description = "Tenant-tagged role the flush assumes with a binding's organization, project, and environment to store that binding's captured attachments."
  type        = string
}

variable "log_retention_in_days" {
  description = "CloudWatch retention for the inbound runtime and flush Lambda log groups."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a CloudWatch Logs retention value."
  }
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}

variable "platform_artifact_bucket_name" {
  description = "Platform artifact bucket name; the flush stores captured provider attachments under its customer prefix."
  type        = string
}

variable "tags" {
  description = "Additional resource tags."
  type        = map(string)
  default     = {}
}

variable "usage_table_arn" {
  description = "Usage table ARN; run admission reads spend budgets and their scope spend from it."
  type        = string
}

variable "usage_table_name" {
  description = "Usage table name."
  type        = string
}
