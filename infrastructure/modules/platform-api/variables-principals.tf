variable "principal_status_function" {
  description = "Platform identity's principal status function, which the system route that disables or re-enables a person invokes. Null on installs without platform identity, where that route refuses."
  type = object({
    arn  = string
    name = string
  })
  default = null
}

variable "organization_creation_quota_per_principal" {
  description = "Organizations one person may create over their lifetime. Erasing an organization does not give one back, and platform administrators are exempt. Null allows any number."
  type        = number
  default     = null

  validation {
    condition = var.organization_creation_quota_per_principal == null || try(
      floor(var.organization_creation_quota_per_principal) == var.organization_creation_quota_per_principal &&
      var.organization_creation_quota_per_principal >= 0 &&
      var.organization_creation_quota_per_principal <= 9007199254740991,
      false,
    )
    error_message = "organization_creation_quota_per_principal must be null or a whole number from 0 to 9007199254740991."
  }
}
