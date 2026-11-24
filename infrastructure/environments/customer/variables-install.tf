variable "environment_name" {
  description = "Name of this install. It names resources and SSM paths, tags every resource Environment=<name>, and prefixes the billing alert resources."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment_name))
    error_message = "environment_name must start with a lowercase letter and have at most 16 lowercase letters, digits, or hyphens."
  }
}

variable "operations" {
  description = "Operational posture of the install: the platform stack's operations object (infrastructure/modules/platform/variables-core.tf) with every field set."
  type        = any
}

variable "deploying_role_name" {
  description = "Name of the IAM role in this account that runs deployments, normally the deploy role infrastructure/bootstrap/customer creates."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9+=,.@_-]{1,64}$", var.deploying_role_name))
    error_message = "deploying_role_name must be an IAM role name without a path."
  }
}

variable "iam_permissions_boundary_arn" {
  description = "Permissions boundary set on every IAM role the stack creates: the permissions_boundary_arn output of infrastructure/bootstrap/customer. The deploy role may write only roles that carry it."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:iam::${var.aws_account_id}:policy/[A-Za-z0-9+=,.@_/-]+$", var.iam_permissions_boundary_arn))
    error_message = "iam_permissions_boundary_arn must be an IAM policy ARN in aws_account_id."
  }
}

variable "system_observer_role_arns" {
  description = "IAM roles in this account whose sessions may read the /v1/system/observer routes, normally the observer role infrastructure/bootstrap/customer creates. Empty disables those routes."
  type        = list(string)

  validation {
    condition = alltrue([
      for arn in var.system_observer_role_arns :
      can(regex("^arn:aws[a-z-]*:iam::${var.aws_account_id}:role/[A-Za-z0-9+=,.@_/-]+$", arn))
    ])
    error_message = "system_observer_role_arns must contain IAM role ARNs in aws_account_id."
  }
}

variable "system_alarm_name_prefix" {
  description = "CloudWatch alarm name prefix the operator routes list. Empty lists every alarm in the install's dedicated account and region; stack alarm names carry no environment prefix."
  type        = string
  default     = ""
  nullable    = false
}

variable "network_cidr_block" {
  description = "IPv4 /16 of the install's private runtime VPC. Choose one that does not overlap networks the customer peers with."
  type        = string

  validation {
    condition     = can(cidrnetmask(var.network_cidr_block)) && endswith(var.network_cidr_block, "/16")
    error_message = "network_cidr_block must be an IPv4 /16 CIDR block."
  }
}

variable "model_runtime_hosted_providers" {
  description = "Hosted model providers the model runtime serves: bedrock, openai, openrouter. bedrock uses the runtime's task role and needs Bedrock model access in the account; openai and openrouter need API keys from secrets sync. Every service model variable must name a hosted provider."
  type        = set(string)
  default     = ["bedrock"]

  validation {
    condition = (
      length(var.model_runtime_hosted_providers) > 0 &&
      alltrue([for provider in var.model_runtime_hosted_providers : contains(["bedrock", "openai", "openrouter"], provider)])
    )
    error_message = "model_runtime_hosted_providers must contain at least one of bedrock, openai, openrouter."
  }
}
