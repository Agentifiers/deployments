variable "sandbox_lambda_microvm_enabled" {
  description = "Whether to create the Lambda MicroVM sandbox prerequisites: the image build bucket, log group, build role, and agent worker policy. The platform-customer profile applies them, publishes the MicroVM image, and verifies a sandbox on every deploy."
  type        = bool
  default     = true

  validation {
    condition     = !var.sandbox_lambda_microvm_enabled || var.agent_runtime_enabled
    error_message = "sandbox_lambda_microvm_enabled requires agent_runtime_enabled."
  }
}

variable "lambda_microvm_image_identifier" {
  description = "Published content-addressed Lambda MicroVM image ARN; set by the deploy tool."
  type        = string
  default     = ""
}

variable "lambda_microvm_image_capacity" {
  description = "Memory and vCPU of the published Lambda MicroVM image; set by the deploy tool."
  type = object({
    memory_mib = number
    vcpu       = number
  })
  default = null
}

variable "lambda_microvm_image_version" {
  description = "Active version of the published Lambda MicroVM image; set by the deploy tool."
  type        = string
  default     = ""
}
