variable "name" {
  description = "Name shared by the TanStack Start Lambda and HTTP API."
  type        = string
}

variable "filename" {
  description = "Path to the deployable TanStack Start Lambda zip archive."
  type        = string
}

variable "handler" {
  description = "Lambda handler exported by the packaged Nitro runtime wrapper."
  type        = string
  default     = "runtime-wrapper.handler"
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
  type    = map(string)
  default = {}
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

variable "permissions_boundary_arn" {
  description = "IAM permissions boundary required on the web workload role."
  type        = string
  default     = ""
}

variable "subnet_ids" {
  type    = list(string)
  default = []
}

variable "security_group_ids" {
  type    = list(string)
  default = []
}

variable "tags" {
  type    = map(string)
  default = {}
}
