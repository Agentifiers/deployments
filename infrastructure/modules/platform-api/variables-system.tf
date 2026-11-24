variable "system_alarm_name_prefix" {
  description = "CloudWatch alarm name prefix the operator routes list; empty lists the account and region."
  type        = string
  default     = ""
  nullable    = false
}

variable "system_bedrock_region" {
  description = "Region the model runtime calls Amazon Bedrock in, or null when Bedrock is not hosted; the operator routes list Bedrock only when set."
  type        = string
  default     = null
}

variable "system_ecs_services" {
  description = "ECS services the operator routes describe."
  type = list(object({
    cluster_arn  = string
    component    = string
    service_name = string
  }))
  default  = []
  nullable = false
}

variable "system_model_provider_secret_arns" {
  description = "Model provider key references (SSM parameter or Secrets Manager ARNs) whose metadata the operator routes read."
  type        = map(string)
  default     = {}
  nullable    = false
}

variable "system_observability" {
  description = "Observability data locations shown to install operators, or null when history is disabled."
  type = object({
    athena_workgroup       = string
    history_retention_days = number
    table_bucket           = string
    table_namespace        = string
  })
  default = null
}

variable "system_observer_role_arns" {
  description = "IAM role ARNs in this account whose assumed-role sessions may call the read-only /v1/system/observer routes. Empty disables those routes."
  type        = list(string)
  default     = []
  nullable    = false

  validation {
    condition = alltrue([
      for arn in var.system_observer_role_arns :
      can(regex("^arn:aws[a-z-]*:iam::${var.account_id}:role/([^/,[:space:]]+/)*[\\w+=.@-]{1,64}$", arn))
    ])
    error_message = "Each system_observer_role_arns entry must be an IAM role ARN in this install's account, such as the platform-observer role the customer bootstrap creates. A role in another account, including the vendor's own principal, can never be admitted. A comma is refused even where IAM allows one, because the API function receives the list comma-joined."
  }
}
