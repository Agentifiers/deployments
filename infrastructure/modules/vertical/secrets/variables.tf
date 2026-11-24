variable "path" {
  description = "Parameter Store path that holds the secrets, such as /verticals/dev/example/secrets."
  type        = string

  validation {
    condition     = can(regex("^(/[A-Za-z0-9_.-]+)+$", var.path))
    error_message = "path must start with / and must not end with /."
  }
}

variable "secret_names" {
  type = set(string)

  validation {
    condition     = alltrue([for name in var.secret_names : can(regex("^[A-Za-z0-9_.-]+$", name))])
    error_message = "Each secret name must be one path segment."
  }
}
