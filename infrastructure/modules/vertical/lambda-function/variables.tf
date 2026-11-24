variable "name" { type = string }
variable "filename" { type = string }

variable "handler" {
  type    = string
  default = "index.handler"
}

variable "runtime" {
  type    = string
  default = "nodejs26.x"
}

variable "architecture" {
  type    = string
  default = "arm64"
}

variable "timeout" {
  type    = number
  default = 30
}

variable "memory_size" {
  type    = number
  default = 1024
}

variable "environment" {
  type    = map(string)
  default = {}
}

variable "secret_environment" {
  description = "Environment variable name to SecureString parameter ARN, hydrated before the handler loads."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for arn in values(var.secret_environment) : can(regex("^arn:[^:]+:ssm:[^:]+:[0-9]{12}:parameter/.+$", arn))])
    error_message = "secret_environment values must be SSM parameter ARNs."
  }
}

variable "optional_secret_environment_names" {
  type    = set(string)
  default = []
}

variable "policy_json" {
  type    = string
  default = ""
}

variable "create_policy" {
  type    = bool
  default = false
}

variable "subnet_ids" {
  type    = list(string)
  default = []
}

variable "security_group_ids" {
  type    = list(string)
  default = []
}

variable "create_function_url" {
  type    = bool
  default = false
}

variable "permissions_boundary_arn" {
  description = "IAM permissions boundary required on the workload execution role."
  type        = string
  default     = ""
}

variable "tags" {
  type    = map(string)
  default = {}
}
