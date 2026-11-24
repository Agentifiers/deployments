variable "client_security_group_id" {
  description = "Security group whose members may reach the forwarded port."
  type        = string
}

variable "environment" {
  description = "Platform environment name."
  type        = string
}

variable "name" {
  description = "Relay name; prefixes AWS resource names and the auth-key parameter path."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,23}$", var.name))
    error_message = "name must be a lowercase name of at most 24 characters."
  }
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}

variable "subnet_id" {
  description = "Private subnet that hosts the relay instance."
  type        = string
}

variable "tags" {
  description = "Additional tags applied to relay resources."
  type        = map(string)
  default     = {}
}

variable "tailnet_hostname" {
  description = "Hostname the relay registers in the tailnet."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,62}$", var.tailnet_hostname))
    error_message = "tailnet_hostname must be a lowercase DNS label."
  }
}

variable "upstream" {
  description = "Tailnet address and TCP port the relay forwards to; the relay listens on the same port."
  type = object({
    address = string
    port    = number
  })
}

variable "vpc_id" {
  description = "VPC that hosts the relay instance."
  type        = string
}
