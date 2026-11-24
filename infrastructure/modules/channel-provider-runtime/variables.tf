variable "alarms_enabled" {
  description = "Whether the module creates its CloudWatch alarms. False creates none, for an installation whose ops alerts reach no one."
  type        = bool
  default     = true
}

variable "alarm_topic_arn" {
  description = "Ops alerts SNS topic ARN notified when an alarm enters or leaves the ALARM state."
  type        = string
}

variable "artifact_bucket" {
  description = "S3 bucket containing the bundled channel/provider Lambda artifact."
  type        = string
}

variable "artifact_key" {
  description = "S3 key containing the bundled channel/provider Lambda artifact."
  type        = string
}

variable "artifact_version" {
  description = "Immutable S3 object version for the Lambda artifact."
  type        = string
}

variable "control_table_arn" {
  description = "ARN of the platform control DynamoDB table."
  type        = string
}

variable "control_table_name" {
  description = "Name of the platform control DynamoDB table."
  type        = string
}

variable "credential_vault_reader_principal_arns" {
  description = "Roles outside this module that may assume the tenant-scoped credential-vault reader, such as the channel ingress flush."
  type        = list(string)
  default     = []
}

variable "domain_name" {
  description = "Public hostname for the channel API, in route53_zone_id. Empty serves it on the execute-api endpoint only."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.domain_name) == "" || can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", lower(trimspace(var.domain_name))))
    error_message = "domain_name must be empty or a DNS hostname."
  }
}

variable "durable_streams_auth_secret_arn" {
  description = "Optional SSM parameter or Secrets Manager ARN containing the Durable Streams auth token used for confirmed external response publication."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.durable_streams_auth_secret_arn) == "" ||
      can(regex("^arn:[^:]+:(ssm|secretsmanager):[^:]+:[0-9]{12}:(parameter/|secret:).+$", trimspace(var.durable_streams_auth_secret_arn)))
    )
    error_message = "durable_streams_auth_secret_arn must be empty or a complete SSM/Secrets Manager ARN."
  }
}

variable "durable_streams_base_url" {
  description = "Optional private Durable Streams base URL used for confirmed external response publication."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.durable_streams_base_url) == "" ||
      can(regex("^https?://[^/[:space:]]+", trimspace(var.durable_streams_base_url)))
    )
    error_message = "durable_streams_base_url must be empty or an absolute HTTP(S) URL."
  }
}

variable "data_kms_key_arn" {
  description = "Shared platform data KMS key ARN that seals credential vault envelopes."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:[^:]+:[0-9]{12}:key/", trimspace(var.data_kms_key_arn)))
    error_message = "data_kms_key_arn must be a valid KMS key ARN."
  }
}

variable "environment" {
  description = "Platform environment name."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be a lowercase name of at most 16 characters."
  }
}

variable "event_bus_arn" {
  description = "ARN of the platform semantic event bus."
  type        = string
}

variable "event_bus_name" {
  description = "Name of the platform semantic event bus."
  type        = string
}

variable "events_table_arn" {
  description = "ARN of the platform events DynamoDB table."
  type        = string
}

variable "events_table_name" {
  description = "Name of the platform events DynamoDB table."
  type        = string
}

variable "execution_table_arn" {
  description = "ARN of the platform execution DynamoDB table."
  type        = string
}

variable "execution_table_name" {
  description = "Name of the platform execution DynamoDB table."
  type        = string
}

variable "jwt_audience" {
  description = "JWT audience accepted by the credential API."
  type        = list(string)

  validation {
    condition     = length(var.jwt_audience) > 0 && alltrue([for value in var.jwt_audience : trimspace(value) != ""])
    error_message = "jwt_audience must contain at least one non-empty audience."
  }
}

variable "jwt_issuer" {
  description = "JWT issuer used by the credential API HTTP authorizer."
  type        = string

  validation {
    condition     = can(regex("^https://[^/[:space:]]+", trimspace(var.jwt_issuer)))
    error_message = "jwt_issuer must be a non-empty HTTPS issuer URL."
  }
}

variable "oauth_apps_json" {
  description = "Secret-free OAuth provider endpoint configuration. Provider request header values must be credential:<field> references resolved from provider-application vault records."
  type        = string
}

variable "oauth_return_origins" {
  description = "Exact HTTPS origins the provider OAuth callback may redirect the browser to (authorization returnTo). Empty disables returnTo redirects."
  type        = list(string)
  default     = []
}

variable "network" {
  description = "VPC and private subnets channel delivery runs in when Durable Streams publication is configured, or null otherwise."
  type = object({
    private_subnet_ids = list(string)
    vpc_id             = string
  })
  default = null
}

variable "log_retention_in_days" {
  description = "CloudWatch retention for the channel and provider runtime Lambda log groups."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a CloudWatch Logs retention value."
  }
}

variable "rcs_provider_role_arns" {
  description = "Explicit vertical-owned IAM roles that channel-delivery may assume for AWS End User Messaging RCS sends."
  type        = set(string)
  default     = []

  validation {
    condition = length(var.rcs_provider_role_arns) <= 50 && alltrue([
      for arn in var.rcs_provider_role_arns : can(regex("^arn:(aws|aws-us-gov|aws-cn):iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", arn))
    ])
    error_message = "rcs_provider_role_arns must contain at most 50 concrete IAM role ARNs without wildcards."
  }
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone containing domain_name, for its certificate and alias records."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.domain_name) == "" || trimspace(var.route53_zone_id) != ""
    error_message = "route53_zone_id is required when domain_name is set."
  }
}

variable "tags" {
  description = "Additional resource tags."
  type        = map(string)
  default     = {}
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}
