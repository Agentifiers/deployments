variable "domain_name" {
  description = "Public HTTPS hostname serving preview sites."
  type        = string

  validation {
    condition = can(regex(
      "^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$",
      var.domain_name,
    ))
    error_message = "domain_name must be a lowercase DNS hostname."
  }
}

variable "environment" {
  description = "Deployment name used only for resource naming and tags."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be a lowercase name of at most 16 characters."
  }
}

variable "route53_zone_id" {
  description = "Public Route 53 hosted zone containing domain_name."
  type        = string

  validation {
    condition     = trimspace(var.route53_zone_id) != ""
    error_message = "route53_zone_id is required."
  }
}

variable "tags" {
  description = "Additional resource tags."
  type        = map(string)
  default     = {}
}
