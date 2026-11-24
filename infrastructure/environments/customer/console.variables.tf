variable "console_enabled" {
  description = "Whether to deploy the management console on platform_identity_application_origin."
  type        = bool
  default     = true
}

variable "console_artifact_bucket" {
  description = "S3 bucket containing the console server Lambda artifact; set by the deploy tool."
  type        = string
  default     = ""
}

variable "console_artifact_key" {
  description = "S3 key containing the console server Lambda artifact; set by the deploy tool."
  type        = string
  default     = ""
}

variable "console_artifact_version" {
  description = "Immutable S3 object version of the console server Lambda artifact; set by the deploy tool."
  type        = string
  default     = ""
}

variable "console_certificate_arn" {
  description = "Existing us-east-1 ACM certificate for the console host. Required unless console_route53_zone_id lets the console issue one."
  type        = string
  default     = ""
}

variable "console_route53_zone_id" {
  description = "Public Route 53 zone containing the console host, for the managed certificate and alias records. Empty leaves DNS to the operator (point the host at the console_distribution_domain_name output)."
  type        = string
  default     = ""
}
