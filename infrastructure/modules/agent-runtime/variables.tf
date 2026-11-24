variable "alarms_enabled" {
  description = "Whether the module creates its CloudWatch alarms. False creates none, for an installation whose ops alerts reach no one."
  type        = bool
  default     = true
}

variable "alarm_topic_arn" {
  description = "Ops alerts SNS topic ARN notified when an alarm enters or leaves the ALARM state."
  type        = string
}

variable "api_jwt_audience" {
  description = "Platform bearer JWT audience (plain or JSON string array) the runtime API accepts alongside API keys; empty with api_jwt_issuer to accept API keys only."
  type        = string
  default     = ""
}

variable "api_jwt_claim_profile" {
  description = "Platform bearer JWT claim compatibility profile; matches the platform API."
  type        = string
  default     = "auto"

  validation {
    condition     = contains(["auto", "cognito", "legacy", "platform"], trimspace(var.api_jwt_claim_profile))
    error_message = "api_jwt_claim_profile must be auto, cognito, legacy, or platform."
  }
}

variable "api_jwt_issuer" {
  description = "HTTPS platform bearer JWT issuer the runtime API accepts; empty with api_jwt_audience to accept API keys only."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.api_jwt_issuer) == "" || can(regex("^https://[^/[:space:]]+", trimspace(var.api_jwt_issuer)))
    error_message = "api_jwt_issuer must be empty or an HTTPS issuer URL."
  }
}

variable "api_reserved_concurrency" {
  description = "Reserved Lambda concurrency for the public runtime API, or -1 for unreserved concurrency."
  type        = number
  default     = 20

  validation {
    condition = (
      var.api_reserved_concurrency == -1 ||
      (
        var.api_reserved_concurrency >= 1 &&
        var.api_reserved_concurrency <= 1000 &&
        floor(var.api_reserved_concurrency) == var.api_reserved_concurrency
      )
    )
    error_message = "api_reserved_concurrency must be -1 or an integer between 1 and 1000."
  }
}

variable "api_throttling_burst_limit" {
  description = "HTTP API burst request limit."
  type        = number
}

variable "api_throttling_rate_limit" {
  description = "HTTP API steady-state requests per second."
  type        = number
}

variable "artifact_bucket_arn" {
  description = "ARN of the platform artifact bucket used for message bodies."
  type        = string
}

variable "artifact_bucket_name" {
  description = "Name of the platform artifact bucket used for message bodies."
  type        = string
}

variable "legacy_artifact_bucket_arns" {
  description = "Legacy platform artifact bucket ARNs retained for bounded reads and cleanup during a naming cutover."
  type        = list(string)
  default     = []
}

variable "legacy_artifact_bucket_names" {
  description = "Legacy platform artifact bucket names accepted for persisted message bodies during a naming cutover."
  type        = list(string)
  default     = []
}

variable "data_kms_key_arn" {
  description = "Shared platform data KMS key ARN: SSE-KMS key for artifact objects and the credential vault envelope key."
  type        = string
}

variable "default_model_spend_ceiling_usd_micros" {
  description = "Monthly operator-funded model spend, in USD micros, that an organization may use when no grant sets its own ceiling. Spend on the organization's own provider keys never counts. Null leaves it unlimited."
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

variable "deletion_protection_enabled" {
  description = "Whether the end-user subject key uses its retained (prevent_destroy) variant. Changing this value moves the key between protected and unprotected resource addresses, which replaces it and orphans every stored subject key."
  type        = bool
}

variable "document_extraction_function_arn" {
  description = "ARN of the document extraction Lambda the runtime API invokes as `type: input` uploads complete."
  type        = string
}

variable "document_extraction_function_name" {
  description = "Name of the document extraction Lambda."
  type        = string
}

variable "durable_streams_auth_secret_arn" {
  description = "SSM SecureString parameter ARN containing the Durable Streams bearer token."
  type        = string
}

variable "durable_streams_base_url" {
  description = "Private Durable Streams base URL."
  type        = string
}

variable "dynamodb_table_arns" {
  description = "Platform DynamoDB table ARNs keyed by logical table name."
  type        = map(string)
}

variable "dynamodb_table_names" {
  description = "Platform DynamoDB table names keyed by logical table name."
  type        = map(string)
}

variable "environment" {
  description = "Deployment environment name."
  type        = string
}

variable "event_bus_name" {
  description = "Semantic EventBridge bus carrying committed run.requested events."
  type        = string

  validation {
    condition     = trimspace(var.event_bus_name) != ""
    error_message = "event_bus_name must not be empty."
  }
}

variable "lambda_artifact_bucket" {
  description = "S3 bucket containing the immutable agent-runtime Lambda bundle."
  type        = string
}

variable "lambda_artifact_key" {
  description = "S3 key containing the immutable agent-runtime Lambda bundle."
  type        = string
}

variable "lambda_artifact_version" {
  description = "Immutable S3 object version for the agent-runtime Lambda bundle."
  type        = string
}

variable "log_retention_in_days" {
  description = "CloudWatch log retention for agent runtime Lambda and workflow log groups."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a CloudWatch Logs retention value."
  }
}

variable "model_catalog_bedrock_region" {
  description = "Deployment region whose Amazon Bedrock model catalog is synchronized. Empty disables Bedrock catalog synchronization."
  type        = string
  default     = ""
}

variable "model_catalog_openai_api_key_secret_arn" {
  description = "SSM SecureString parameter ARN containing the OpenAI API key used to list the models it can serve. Empty skips the OpenAI model listing."
  type        = string
  default     = ""

  validation {
    condition     = var.model_catalog_openai_api_key_secret_arn == "" || can(regex("^arn:[^:]+:ssm:[^:]+:[0-9]{12}:parameter/", var.model_catalog_openai_api_key_secret_arn))
    error_message = "model_catalog_openai_api_key_secret_arn must be empty or an SSM parameter ARN."
  }
}

variable "model_catalog_openai_model_ids" {
  description = "Bare OpenAI model ids (without the openai/ prefix) the catalog lists in place of the OpenAI model listing, for a relayed openai provider. Empty lists none."
  type        = list(string)
  default     = []
}

variable "model_gateway_base_url" {
  description = "Private model gateway origin; clients append /v1."
  type        = string
}

variable "model_gateway_token_signing_key_arn" {
  description = "KMS key ARN the model token issuers sign gateway tokens with."
  type        = string

  validation {
    condition     = can(regex("^arn:[^:]+:kms:[^:]+:[0-9]{12}:key/.+$", var.model_gateway_token_signing_key_arn))
    error_message = "model_gateway_token_signing_key_arn must be a KMS key ARN."
  }
}

variable "model_grants_parameter_arn" {
  description = "SSM SecureString parameter ARN holding the operator model grants JSON."
  type        = string

  validation {
    condition     = can(regex("^arn:[^:]+:ssm:[^:]+:[0-9]{12}:parameter/.+$", var.model_grants_parameter_arn))
    error_message = "model_grants_parameter_arn must be an SSM parameter ARN."
  }
}

variable "model_token_service_models" {
  description = "Canonical model ids each service token issuer may always mint tokens for."
  type = object({
    agent_worker = list(string)
    brain        = list(string)
    memory       = list(string)
    web_tools    = list(string)
  })
}

variable "model_token_service_fallback_models" {
  description = "Fallback model ids service chat calls without explicit fallbacks request (DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS on the agent worker and evaluation worker); the agent-worker, evaluations, memory, and brain issuers admit them."
  type        = list(string)
}

variable "model_token_embedding_models" {
  description = "Embedding model ids services call. Token issuers keep them operator-funded and never refuse them at an organization's spend ceiling."
  type        = list(string)
  default     = []
  nullable    = false
}

variable "model_credential_providers" {
  description = "Providers organizations may pay for with their own stored key (model_credential_providers on the platform). Token issuers sign an organization's active key for these providers into its tokens; empty leaves every model call operator-funded."
  type        = list(string)
  default     = []
  nullable    = false

  validation {
    condition     = length(setsubtract(var.model_credential_providers, ["openai", "openrouter"])) == 0
    error_message = "model_credential_providers may list only openai and openrouter."
  }
}

variable "private_subnet_ids" {
  description = "Private subnets with access to the model gateway and Durable Streams."
  type        = list(string)
}

variable "worker_additional_security_group_ids" {
  description = "Additional caller-identity security groups attached to the agent worker task and evaluation worker Lambda ENIs."
  type        = list(string)
  default     = []
}

variable "ecs_cluster_arn" {
  description = "Existing private platform ECS cluster that hosts the agent worker service. It must register the FARGATE and FARGATE_SPOT capacity providers."
  type        = string

  validation {
    condition     = can(regex("^arn:[^:]+:ecs:[^:]+:[0-9]{12}:cluster/.+$", var.ecs_cluster_arn))
    error_message = "ecs_cluster_arn must be an ECS cluster ARN."
  }
}

variable "fargate_spot_enabled" {
  description = "Whether the agent worker runs on FARGATE_SPOT instead of FARGATE capacity."
  type        = bool
}

variable "agent_worker_image" {
  description = "Digest-pinned ARM64 image built from functions/worker/Dockerfile."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.agent_worker_image))
    error_message = "agent_worker_image must be pinned by sha256 digest."
  }
}

variable "worker_cpu" {
  description = "Fargate CPU units for one agent worker task."
  type        = number

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.worker_cpu)
    error_message = "worker_cpu must be a Fargate CPU size between 256 and 4096."
  }
}

variable "worker_memory" {
  description = "Fargate memory in MiB for one agent worker task."
  type        = number

  validation {
    condition     = var.worker_memory >= 512 && var.worker_memory <= 30720 && floor(var.worker_memory) == var.worker_memory
    error_message = "worker_memory must be an integer MiB value between 512 and 30720."
  }
}

variable "worker_max_concurrent_runs" {
  description = "Agent runs one worker task executes concurrently; run-slot utilization is measured against it."
  type        = number

  validation {
    condition     = var.worker_max_concurrent_runs >= 1 && var.worker_max_concurrent_runs <= 64 && floor(var.worker_max_concurrent_runs) == var.worker_max_concurrent_runs
    error_message = "worker_max_concurrent_runs must be an integer between 1 and 64."
  }
}

variable "worker_min_count" {
  description = "Minimum agent worker task count kept by autoscaling."
  type        = number

  validation {
    condition     = var.worker_min_count >= 1 && floor(var.worker_min_count) == var.worker_min_count
    error_message = "worker_min_count must be a positive integer."
  }
}

variable "worker_max_count" {
  description = "Maximum agent worker task count autoscaling may reach."
  type        = number

  validation {
    condition     = var.worker_max_count >= 1 && var.worker_max_count <= 200 && floor(var.worker_max_count) == var.worker_max_count
    error_message = "worker_max_count must be an integer between 1 and 200."
  }
}

variable "stream_gateway_base_url" {
  description = "Public stream gateway origin used to build thread stream URLs, or empty when the gateway is not deployed."
  type        = string
  default     = ""

  validation {
    condition     = var.stream_gateway_base_url == "" || can(regex("^https://[^/]+$", var.stream_gateway_base_url))
    error_message = "stream_gateway_base_url must be empty or an https origin without a path."
  }
}

variable "runtime_environment_variables" {
  description = "Additional platform-tool, memory, and sandbox environment variables for the agent worker and the Lambdas that share its runtime environment."
  type        = map(string)
  default     = {}
}

variable "runtime_policy_arns" {
  description = "Managed IAM policies required by configured runtime providers, keyed by stable logical names. Attached to the agent worker task role and the runtime Lambda role."
  type        = map(string)
  default     = {}
}

variable "runtime_secret_arns" {
  description = "Additional platform-tool, memory, and sandbox SecureString parameters readable by the agent worker and runtime Lambdas."
  type        = list(string)
  default     = []
}

variable "webhook_events_reserved_concurrency" {
  description = "Reserved concurrency for webhook event fan-out, or -1 to use unreserved account concurrency."
  type        = number
  default     = 10

  validation {
    condition = (
      var.webhook_events_reserved_concurrency == -1 ||
      (
        var.webhook_events_reserved_concurrency >= 1 &&
        var.webhook_events_reserved_concurrency <= 1000 &&
        floor(var.webhook_events_reserved_concurrency) == var.webhook_events_reserved_concurrency
      )
    )
    error_message = "webhook_events_reserved_concurrency must be -1 or an integer between 1 and 1000."
  }
}

variable "webhook_delivery_retention_days" {
  description = "Days webhook delivery and attempt records are retained after their last attempt before DynamoDB TTL removes them."
  type        = number

  validation {
    condition = (
      floor(var.webhook_delivery_retention_days) == var.webhook_delivery_retention_days &&
      var.webhook_delivery_retention_days >= 1 &&
      var.webhook_delivery_retention_days <= 3650
    )
    error_message = "webhook_delivery_retention_days must be a whole number of days between 1 and 3650."
  }
}

variable "webhook_delivery_maximum_concurrency" {
  description = "Maximum concurrent webhook delivery worker invocations polling the delivery queue."
  type        = number
  default     = 10

  validation {
    condition = (
      floor(var.webhook_delivery_maximum_concurrency) == var.webhook_delivery_maximum_concurrency &&
      var.webhook_delivery_maximum_concurrency >= 2 &&
      var.webhook_delivery_maximum_concurrency <= 1000
    )
    error_message = "webhook_delivery_maximum_concurrency must be an integer between 2 and 1000."
  }
}

variable "legacy_webhook_signing_secret_arns" {
  description = "Explicit Secrets Manager ARN allowlist for legacy webhook signing secrets."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Additional tags."
  type        = map(string)
  default     = {}
}

variable "vpc_id" {
  description = "VPC hosting the private runtime services."
  type        = string
}

variable "usage_table_stream_arn" {
  description = "DynamoDB Stream ARN for the usage table."
  type        = string
}

variable "execution_table_stream_arn" {
  description = "DynamoDB Stream ARN for the execution table."
  type        = string
}

variable "oauth_refresh_function_arn" {
  description = "ARN of the IAM-invoked OAuth refresh Lambda; empty disables invoke permission."
  type        = string
  default     = ""
  nullable    = false
}

variable "oauth_refresh_function_name" {
  description = "Name of the IAM-invoked OAuth refresh Lambda."
  type        = string
  default     = ""
  nullable    = false
}

variable "request_admission_table_arn" {
  description = "ARN of the per-organization request admission table."
  type        = string
}

variable "request_admission_table_name" {
  description = "Name of the per-organization request admission table."
  type        = string
}

variable "tenant_limit_defaults_json" {
  description = "JSON-encoded operations.tenant_limit_defaults read by the runtime API and agent worker."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}

variable "alert_email" {
  description = "Alert email delivery. An empty sender turns monitors' evaluation and email off. Self-hosted installs set their own verified SES sender and product name; the observability fields enable trace metric monitors."
  type = object({
    console_origin           = optional(string, "")
    observability_base_url   = optional(string, "")
    observability_secret_arn = optional(string, "")
    product_name             = optional(string, "Deployments.ai")
    sender                   = optional(string, "")
  })
  default  = {}
  nullable = false

  validation {
    condition     = trimspace(var.alert_email.sender) == "" || can(regex("^[^@[:space:]]+@[^@[:space:]]+$", trimspace(var.alert_email.sender)))
    error_message = "alert_email.sender must be empty or a valid mailbox address."
  }
}
