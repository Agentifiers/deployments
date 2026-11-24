variable "observability_base_url" {
  description = "Private observability hot-plane API URL, or empty when Phase 3 is disabled."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.observability_base_url) == "" ||
      can(regex("^http://[a-z0-9.-]+:[0-9]+$", trimspace(var.observability_base_url)))
    )
    error_message = "observability_base_url must be empty or a private HTTP origin."
  }
}

variable "observability_secret_arn" {
  description = "SSM SecureString parameter ARN containing the internal observability service token."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.observability_secret_arn) == "" ||
      can(regex("^arn:[^:]+:ssm:[^:]+:[0-9]{12}:parameter/.+$", trimspace(var.observability_secret_arn)))
    )
    error_message = "observability_secret_arn must be empty or an SSM parameter ARN."
  }
}

variable "observability_secret_version_id" {
  description = "Deprecated Secrets Manager version selector; leave empty for SSM Parameter Store."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.observability_secret_version_id) == "" ||
      can(regex("^[0-9]+$", trimspace(var.observability_secret_version_id)))
    )
    error_message = "observability_secret_version_id must be empty or an SSM parameter version."
  }
}

variable "observability_erasure_function_arn" {
  description = "ARN of the observability tenant-erasure Lambda, or empty when observability history is disabled."
  type        = string
  default     = ""
}

variable "observability_erasure_function_name" {
  description = "Name of the observability tenant-erasure Lambda, or empty when observability history is disabled."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.observability_erasure_function_name) == "" || can(regex("^[A-Za-z0-9_-]{1,64}$", trimspace(var.observability_erasure_function_name)))
    error_message = "observability_erasure_function_name must be empty or a Lambda function name."
  }
}
