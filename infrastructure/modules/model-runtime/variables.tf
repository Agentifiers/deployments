variable "bifrost_desired_count" {
  description = "Model gateway task count (each task runs Bifrost and the gateway). Keep at zero until runtime parameters are populated."
  type        = number
  default     = 0

  validation {
    condition     = var.bifrost_desired_count >= 0 && var.bifrost_desired_count <= 4
    error_message = "bifrost_desired_count must be between zero and four."
  }
}

variable "alarms_enabled" {
  description = "Whether the module creates its CloudWatch alarms. False creates none, for an installation whose ops alerts reach no one."
  type        = bool
  default     = true
}

variable "alarm_topic_arn" {
  description = "Ops alerts SNS topic ARN notified when an alarm enters or leaves the ALARM state."
  type        = string
}

variable "bifrost_image" {
  description = "Digest-pinned ARM64 Bifrost image the deploy tool publishes from the release (infrastructure/images/bifrost)."
  type        = string
}

variable "compact_task_sizing_enabled" {
  description = "Whether the model gateway task runs the compact size (512 CPU / 1024 MiB) instead of 1024 CPU / 2048 MiB."
  type        = bool
}

variable "container_insights_enabled" {
  description = "Whether ECS Container Insights is enabled on the model runtime cluster."
  type        = bool
}

variable "control_table_arn" {
  description = "Control DynamoDB table ARN; the gateway reads organization standing (the operator-funded spend ceiling) and sealed organization provider keys from it."
  type        = string
}

variable "control_table_name" {
  description = "Control DynamoDB table name."
  type        = string
}

variable "default_model_spend_ceiling_usd_micros" {
  description = "Monthly operator-funded model spend, in USD micros, that an organization may use when no grant sets its own ceiling; the same value the token issuers receive. Null leaves it unlimited."
  type        = number
  default     = null

  validation {
    condition = var.default_model_spend_ceiling_usd_micros == null || try(
      floor(var.default_model_spend_ceiling_usd_micros) == var.default_model_spend_ceiling_usd_micros &&
      var.default_model_spend_ceiling_usd_micros >= 0 &&
      var.default_model_spend_ceiling_usd_micros <= 9007199254740991,
      false,
    )
    error_message = "default_model_spend_ceiling_usd_micros must be null or a whole number of USD micros from 0 to 9007199254740991."
  }
}

variable "execution_table_arn" {
  description = "Execution DynamoDB table ARN; the gateway reads run execution leases from it."
  type        = string
}

variable "execution_table_name" {
  description = "Execution DynamoDB table name."
  type        = string
}

variable "model_credentials" {
  description = "Organization provider keys the gateway serves organization-funded calls with: the dedicated KMS key that opens the sealed keys in the control table. Null leaves every call on the operator's provider keys."
  type = object({
    kms_key_arn = string
  })
  default = null
}

variable "usage_table_arn" {
  description = "Usage DynamoDB table ARN; the gateway reads organization month spend shards from it."
  type        = string
}

variable "usage_table_name" {
  description = "Usage DynamoDB table name."
  type        = string
}

variable "kms_deletion_window_in_days" {
  description = "Deletion window for the model gateway token signing key."
  type        = number

  validation {
    condition     = var.kms_deletion_window_in_days >= 7 && var.kms_deletion_window_in_days <= 30
    error_message = "kms_deletion_window_in_days must be between 7 and 30."
  }
}

variable "model_gateway_image" {
  description = "Digest-pinned ARM64 image built from apps/model-gateway/Dockerfile; renders the Bifrost config and runs the gateway."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.model_gateway_image))
    error_message = "model_gateway_image must be pinned by sha256 digest."
  }
}

variable "model_gateway_previous_signing_key_arns" {
  description = "Retired token signing KMS key ARNs the gateway still trusts during a key rotation. Empty outside a rotation."
  type        = list(string)
  default     = []

  validation {
    condition = alltrue([
      for arn in var.model_gateway_previous_signing_key_arns : can(regex("^arn:[^:]+:kms:[^:]+:[0-9]{12}:key/.+$", arn))
    ])
    error_message = "model_gateway_previous_signing_key_arns must contain KMS key ARNs (not aliases)."
  }
}

variable "hosted_providers" {
  description = "Hosted Bifrost providers. API-key providers (openai, openrouter) get managed parameters and Bifrost secrets; bedrock authenticates with the task role in the deployment region."
  type        = set(string)
  default     = ["openai", "openrouter"]

  validation {
    condition = (
      length(var.hosted_providers) > 0 &&
      alltrue([for provider in var.hosted_providers : contains(["bedrock", "openai", "openrouter"], provider)])
    )
    error_message = "hosted_providers must contain at least one supported provider: bedrock, openai, openrouter."
  }
}

variable "https_client_security_group_ids" {
  description = "Security groups whose callers may reach additional HTTPS listeners on the shared internal load balancer, keyed by a static client name so a first plan can key the rules before the groups exist."
  type        = map(string)
  default     = {}
}

variable "openai_base_url" {
  description = "OpenAI-compatible origin (scheme, host, optional port; no path or trailing slash) that replaces api.openai.com for the openai provider. Empty uses OpenAI."
  type        = string
  default     = ""

  validation {
    condition     = var.openai_base_url == "" || can(regex("^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$", var.openai_base_url))
    error_message = "openai_base_url must be empty or an http(s) origin without a path or trailing slash."
  }

  validation {
    condition     = var.openai_base_url == "" || contains(var.hosted_providers, "openai")
    error_message = "openai_base_url requires openai in hosted_providers."
  }
}

variable "deletion_protection_enabled" {
  description = "Whether deletion protection is enabled for persistent runtime resources."
  type        = bool
}

variable "environment" {
  description = "Platform environment name."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be a lowercase name of at most 16 characters."
  }
}

variable "log_retention_in_days" {
  description = "CloudWatch log retention for the model gateway task log group."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a CloudWatch Logs retention value."
  }
}

variable "secret_recovery_window_in_days" {
  description = "Secrets Manager recovery window."
  type        = number
  default     = 0
}

variable "tags" {
  description = "Additional tags applied to model runtime resources."
  type        = map(string)
  default     = {}
}

variable "private_subnet_ids" {
  description = "Private platform subnet IDs for ECS."
  type        = list(string)
}

variable "vpc_cidr" {
  description = "CIDR assigned to the shared platform VPC."
  type        = string
}

variable "vpc_id" {
  description = "Shared platform VPC ID."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}
