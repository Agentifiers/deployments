variable "environment" {
  description = "Deployment environment."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be a lowercase name of at most 16 characters."
  }
}

variable "lambda_microvm_enabled" {
  description = "Whether to provision Lambda MicroVM image build and worker IAM prerequisites."
  type        = bool
  default     = false
}

variable "lambda_microvm_execution_role_arn" {
  description = "IAM execution role passed to each Lambda MicroVM. Empty creates a role that can only write runtime logs to the sandbox log group; a role passed here needs that permission to keep the logs. The runtime policy grants iam:PassRole only for the role in use."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.lambda_microvm_execution_role_arn) == "" ||
      can(regex("^arn:[^:]+:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", trimspace(var.lambda_microvm_execution_role_arn)))
    )
    error_message = "lambda_microvm_execution_role_arn must be empty or an IAM role ARN."
  }
}

variable "lambda_microvm_image_identifier" {
  description = "Published content-addressed Lambda MicroVM image ARN. Empty during prerequisite bootstrap."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.lambda_microvm_image_identifier) == "" ||
      can(regex("^arn:[^:]+:lambda:[a-z0-9-]+:[0-9]{12}:microvm-image[:/][A-Za-z0-9._/@:-]+$", trimspace(var.lambda_microvm_image_identifier)))
    )
    error_message = "lambda_microvm_image_identifier must be empty or a Lambda MicroVM image ARN."
  }
}

variable "lambda_microvm_image_version" {
  description = "Active version of the published content-addressed Lambda MicroVM image."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.lambda_microvm_image_version) == "" ||
      can(regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", trimspace(var.lambda_microvm_image_version)))
    )
    error_message = "lambda_microvm_image_version must be empty or a valid active image version."
  }
}

variable "lambda_microvm_image_capacity" {
  description = "Memory and vCPU each MicroVM of the image runs with, which the worker reserves and meters; a supported Lambda MicroVM pair. Null uses the worker's 2048 MiB and 1 vCPU default."
  type = object({
    memory_mib = number
    vcpu       = number
  })
  default = null

  validation {
    condition = var.lambda_microvm_image_capacity == null || contains(
      ["512:0.25", "1024:0.5", "2048:1", "4096:2", "8192:4"],
      "${var.lambda_microvm_image_capacity.memory_mib}:${var.lambda_microvm_image_capacity.vcpu}",
    )
    error_message = "lambda_microvm_image_capacity must be a supported pair: 512 MiB and 0.25 vCPU, 1024 and 0.5, 2048 and 1, 4096 and 2, or 8192 and 4."
  }
}

variable "log_retention_in_days" {
  description = "CloudWatch log retention for the Lambda MicroVM log group."
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

variable "tags" {
  description = "Additional tags applied to sandbox runtime resources."
  type        = map(string)
  default     = {}
}

variable "usage_cost_policy" {
  description = "Hourly USD-micro sandbox rates the worker writes on sandbox meter events; null leaves sandbox usage unpriced. Validated by the platform module's sandbox_usage_cost_policy."
  type = object({
    base_hour_usd_micros       = optional(number)
    memory_gib_hour_usd_micros = optional(number)
    vcpu_hour_usd_micros       = optional(number)
  })
  default = null
}
