variable "aws_account_id" {
  description = "Dedicated AWS account of the install."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be a 12-digit AWS account ID."
  }
}

variable "aws_region" {
  description = "AWS region of the install; the state bucket lives here."
  type        = string
}

variable "environment_name" {
  description = "environment_name the install's customer root will use; it scopes the deploy role's IAM name prefixes."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment_name))
    error_message = "environment_name must start with a lowercase letter and have at most 16 lowercase letters, digits, or hyphens."
  }
}

variable "deploy_principal_arn" {
  description = "Existing IAM role or user allowed to assume the deploy role: your CI role or administrator role, or a vendor's role in another account."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:(role|user)/[A-Za-z0-9+=,.@_/-]+$", var.deploy_principal_arn))
    error_message = "deploy_principal_arn must be an IAM role or user ARN."
  }
}

variable "observer_principal_arn" {
  description = "Existing IAM role or user allowed to assume the observer role. Null creates no observer role."
  type        = string
  default     = null

  validation {
    condition     = var.observer_principal_arn == null || can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:(role|user)/[A-Za-z0-9+=,.@_/-]+$", var.observer_principal_arn))
    error_message = "observer_principal_arn must be null or an IAM role or user ARN."
  }
}

variable "external_id" {
  description = "Secret every principal presents as sts:ExternalId when it assumes the deploy and observer roles. Required when either principal is in another account; null adds no ExternalId condition."
  type        = string
  default     = null
  sensitive   = true

  validation {
    condition     = var.external_id == null || (length(var.external_id) >= 16 && length(var.external_id) <= 1224 && can(regex("^[A-Za-z0-9+=,.@:/-]+$", var.external_id)))
    error_message = "external_id must be 16 to 1224 characters of letters, digits, or +=,.@:/-."
  }

  validation {
    condition = var.external_id != null || alltrue([
      for arn in [var.deploy_principal_arn, var.observer_principal_arn] :
      try(split(":", arn)[4], var.aws_account_id) == var.aws_account_id if arn != null
    ])
    error_message = "external_id is required when deploy_principal_arn or observer_principal_arn is in an account other than aws_account_id."
  }
}

variable "deploy_role_name" {
  description = "Name of the deploy role; the customer root's deploying_role_name must match it."
  type        = string
  default     = "platform-deploy"
}

variable "deploy_managed_policy_names" {
  description = "AWS managed policies attached to the deploy role. Keep IAM permissions out of them: the role's own IAM grants are limited to the platform's names and to roles that carry the workload permissions boundary, and an IAM-granting managed policy bypasses every limit except the role-write and boundary denies."
  type        = set(string)
  default     = ["PowerUserAccess"]
}

variable "observer_role_name" {
  description = "Name of the observer role; list its ARN in the customer root's system_observer_role_arns."
  type        = string
  default     = "platform-observer"
}

variable "permissions_boundary_name" {
  description = "Name of the permissions boundary policy every platform role must carry; pass its ARN as the customer root's iam_permissions_boundary_arn."
  type        = string
  default     = "platform-workload-boundary"
}
