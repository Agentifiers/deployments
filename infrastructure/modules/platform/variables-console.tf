# Requirements that depend on deploy-tool inputs (artifact references, identity, and the platform
# API) are validated inside modules/console, so targeted bootstrap applies that run before the
# release variables exist never evaluate them.
variable "console_enabled" {
  description = "Whether to deploy the management console on platform_identity_application_origin. Requires platform_api_enabled and platform_identity_enabled."
  type        = bool
  default     = false
}

variable "console_additional_environment" {
  description = "Extra Lambda environment variables for a replacement console build that reaches its own services. Keys starting with CONSOLE_ are refused."
  type        = map(string)
  default     = {}
  nullable    = false
}

variable "console_docs_origin" {
  description = "Exact https origin of the install's documentation site, which deploys separately from the platform. The console links to it; empty hides the links."
  type        = string
  default     = ""
  nullable    = false
}

variable "console_additional_policy_json" {
  description = "IAM policy document attached to the console role as a separate inline policy, for a replacement console build that reaches its own services. Null attaches none."
  type        = string
  default     = null
}

variable "console_artifact_bucket" {
  description = "S3 bucket containing the console server Lambda artifact."
  type        = string
  default     = ""
}

variable "console_artifact_key" {
  description = "S3 key containing the console server Lambda artifact."
  type        = string
  default     = ""
}

variable "console_artifact_version" {
  description = "Immutable S3 object version of the console server Lambda artifact."
  type        = string
  default     = ""
}

variable "console_certificate_arn" {
  description = "Existing us-east-1 ACM certificate for the application origin host. When empty, the console issues one in console_route53_zone_id."
  type        = string
  default     = ""
}

variable "console_route53_zone_id" {
  description = "Public Route 53 zone containing the application origin host, for the managed certificate and alias records. Empty leaves DNS to the operator."
  type        = string
  default     = ""
}
