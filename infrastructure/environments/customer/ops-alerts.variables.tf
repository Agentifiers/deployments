variable "ops_alerts_notifier_artifact_bucket" {
  description = "S3 bucket containing the ops alerts notifier Lambda artifact."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.ops_alerts_notifier_artifact_bucket) != ""
    error_message = "ops_alerts_notifier_artifact_bucket is required."
  }
}

variable "ops_alerts_notifier_artifact_key" {
  description = "S3 object key for the ops alerts notifier Lambda artifact."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.ops_alerts_notifier_artifact_key) != ""
    error_message = "ops_alerts_notifier_artifact_key is required."
  }
}

variable "ops_alerts_notifier_artifact_version" {
  description = "Immutable S3 object version for the ops alerts notifier Lambda artifact."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.ops_alerts_notifier_artifact_version) != "" &&
      lower(trimspace(var.ops_alerts_notifier_artifact_version)) != "null"
    )
    error_message = "A non-null ops_alerts_notifier_artifact_version is required."
  }
}
