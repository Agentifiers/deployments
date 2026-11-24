variable "bucket_name" {
  description = "Globally unique S3 bucket that stores published releases."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be a valid S3 bucket name."
  }
}

variable "deployer_repository_name" {
  description = "ECR repository holding the deployer image."
  type        = string
  default     = "deployments-ai/platform/deployer"
}

variable "dev_retention_days" {
  description = "Days after publish when bundle files still tagged retention=dev and object=payload expire. Records and signatures never expire."
  type        = number
  default     = 180

  validation {
    condition     = var.dev_retention_days >= 1 && floor(var.dev_retention_days) == var.dev_retention_days
    error_message = "dev_retention_days must be a positive whole number."
  }
}

variable "github_oidc_provider_arn" {
  description = "Existing GitHub Actions OIDC provider in this account. Null creates one."
  type        = string
  default     = null

  validation {
    condition     = var.github_oidc_provider_arn == null || can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:oidc-provider/token\\.actions\\.githubusercontent\\.com$", var.github_oidc_provider_arn))
    error_message = "github_oidc_provider_arn must be the ARN of the token.actions.githubusercontent.com OIDC provider."
  }
}

variable "github_subject" {
  description = "Full GitHub OIDC subject the publisher role trusts: the repository's subject prefix followed by :environment:<name> or :ref:<ref>."
  type        = string

  validation {
    condition     = startswith(var.github_subject, "repo:") && (strcontains(var.github_subject, ":environment:") || strcontains(var.github_subject, ":ref:"))
    error_message = "github_subject must start with repo: and name a GitHub environment (:environment:<name>) or a ref (:ref:<ref>)."
  }
}

variable "publisher_role_name" {
  description = "IAM role GitHub Actions assumes to publish releases."
  type        = string
  default     = "platform-release-publisher"
}

variable "reader_policy_name" {
  description = "Managed IAM policy that lets readers read, retain, and pull releases."
  type        = string
  default     = "platform-release-reader"
}

variable "reader_role_names" {
  description = "IAM roles in this account that get the reader policy."
  type        = list(string)
  default     = []
  nullable    = false
}

variable "signing_key_alias" {
  description = "KMS alias of the release record signing key."
  type        = string
  default     = "alias/platform-release-signing"

  validation {
    condition     = startswith(var.signing_key_alias, "alias/") && !startswith(var.signing_key_alias, "alias/aws/")
    error_message = "signing_key_alias must start with alias/ and must not use the reserved alias/aws/ prefix."
  }
}

variable "tags" {
  description = "Additional resource tags."
  type        = map(string)
  default     = {}
}
