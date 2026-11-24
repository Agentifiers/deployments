variable "account_id" {
  description = "AWS account that owns the API. Observer sessions must come from it."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "account_id must be a 12-digit AWS account ID."
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

variable "apps_runtime" {
  description = "Agent-built apps runtime: environment for the API and governance worker, the policy that lets them call the apps-database Lambda, the policy that lets the API ask the apps-domains Lambda to converge a domain, and the governance worker's export read policy. Null when apps are disabled."
  type = object({
    domain_reconciler_invoke_policy_arn = string
    environment                         = map(string)
    export_read_policy_arn              = string
    invoke_policy_arn                   = string
  })
  default = null
}

variable "agent_email_api_enabled" {
  description = "Whether the unified gateway should publish routes backed by the agent-email API Lambda."
  type        = bool
  default     = false
}

variable "agent_email_api_function_name" {
  description = "Optional function name of the agent-email API Lambda integrated with the unified gateway."
  type        = string
  default     = ""

  validation {
    condition     = !var.agent_email_api_enabled || trimspace(var.agent_email_api_function_name) != ""
    error_message = "agent_email_api_function_name must not be empty when agent_email_api_enabled is true."
  }
}

variable "agent_email_api_invoke_arn" {
  description = "Optional invoke ARN of the agent-email API Lambda integrated with the unified gateway."
  type        = string
  default     = ""

  validation {
    condition     = !var.agent_email_api_enabled || trimspace(var.agent_email_api_invoke_arn) != ""
    error_message = "agent_email_api_invoke_arn must not be empty when agent_email_api_enabled is true."
  }
}

variable "agent_email_bucket_arn" {
  description = "ARN of the agent-email bucket containing governed tenant email content."
  type        = string
}

variable "agent_email_bucket_name" {
  description = "Name of the agent-email bucket containing governed tenant email content."
  type        = string
}

variable "legacy_agent_email_bucket_arns" {
  description = "Legacy agent-email bucket ARNs retained for governed reads and erasure during an account-local naming cutover."
  type        = list(string)
  default     = []
}

variable "legacy_agent_email_bucket_names" {
  description = "Legacy agent-email bucket names included in the tenant governance boundary during an account-local naming cutover."
  type        = list(string)
  default     = []
}

variable "agent_observability_quarantine_bucket_arn" {
  description = "Optional ARN of the governed observability quarantine bucket."
  type        = string
  default     = null
  nullable    = true
}

variable "agent_observability_quarantine_bucket_name" {
  description = "Optional name of the governed observability quarantine bucket."
  type        = string
  default     = null
  nullable    = true
}

variable "artifact_bucket" {
  description = "S3 bucket containing the bundled functions/api Lambda artifact."
  type        = string

  validation {
    condition     = trimspace(var.artifact_bucket) != ""
    error_message = "artifact_bucket must not be empty."
  }
}

variable "artifact_key" {
  description = "S3 key containing the bundled functions/api Lambda artifact."
  type        = string

  validation {
    condition     = trimspace(var.artifact_key) != ""
    error_message = "artifact_key must not be empty."
  }
}

variable "artifact_version" {
  description = "Immutable S3 object version for the bundled functions/api Lambda artifact."
  type        = string

  validation {
    condition = (
      trimspace(var.artifact_version) != "" &&
      lower(trimspace(var.artifact_version)) != "null"
    )
    error_message = "artifact_version must be a non-null immutable S3 object version."
  }
}

variable "brain_runtime_environment_variables" {
  description = "Brain query runtime environment variables supplied by the isolated Brain runtime module."
  type        = map(string)
  default     = {}
}

variable "brain_runtime_policy_arn" {
  description = "IAM policy allowing direct API Brain queries."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:iam::[0-9]{12}:policy/", trimspace(var.brain_runtime_policy_arn)))
    error_message = "brain_runtime_policy_arn must be a valid IAM policy ARN."
  }
}

variable "platform_artifact_bucket_arn" {
  description = "ARN of the platform data bucket containing tenant artifacts and message bodies."
  type        = string
}

variable "platform_artifact_bucket_name" {
  description = "Name of the platform data bucket containing tenant artifacts and message bodies."
  type        = string
}

variable "legacy_platform_artifact_bucket_arns" {
  description = "Legacy platform artifact bucket ARNs retained for reads and governance cleanup during a naming cutover."
  type        = list(string)
  default     = []
}

variable "legacy_platform_artifact_bucket_names" {
  description = "Legacy platform artifact bucket names included in governance and Brain runtime boundaries during a naming cutover."
  type        = list(string)
  default     = []
}

variable "certificate_arn" {
  description = "Regional ACM certificate ARN for the canonical public API domain."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:acm:[^:]+:[0-9]{12}:certificate/", trimspace(var.certificate_arn)))
    error_message = "certificate_arn must be a valid ACM certificate ARN."
  }
}

variable "control_table_arn" {
  description = "ARN of the platform control DynamoDB table."
  type        = string
}

variable "control_table_name" {
  description = "Name of the platform control DynamoDB table."
  type        = string
}

variable "data_kms_key_arn" {
  description = "Shared platform data KMS key ARN: SSE-KMS key for artifact and governance objects and the idempotency, operational cursor, and credential vault envelope key."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:[^:]+:[0-9]{12}:key/", trimspace(var.data_kms_key_arn)))
    error_message = "data_kms_key_arn must be a valid KMS key ARN."
  }
}

variable "domain_name" {
  description = "Canonical public API hostname."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$", lower(trimspace(var.domain_name))))
    error_message = "domain_name must be a valid DNS hostname."
  }
}

variable "device_authorization_client_id" {
  description = "RFC 8628 OAuth client ID used by the API proxy, or empty to disable interactive device login."
  type        = string
  default     = ""
}

variable "device_authorization_issuer" {
  description = "OIDC issuer advertising RFC 8628 endpoints; must equal jwt_issuer, or remain empty to disable interactive device login."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.device_authorization_issuer) == "" ||
      can(regex("^https://[^/[:space:]]+", trimspace(var.device_authorization_issuer)))
    )
    error_message = "device_authorization_issuer must be empty or an HTTPS issuer URL."
  }
}

variable "dynamodb_table_arns" {
  description = "Platform DynamoDB table ARNs keyed by logical table name."
  type        = map(string)
}

variable "dynamodb_table_names" {
  description = "Platform DynamoDB table names keyed by logical table name."
  type        = map(string)
}

variable "durable_streams_auth_secret_arn" {
  description = "SSM SecureString parameter ARN of the internal Durable Streams token; the governance worker deletes erased threads' streams."
  type        = string
}

variable "durable_streams_base_url" {
  description = "Internal Durable Streams base URL, reachable from the platform VPC."
  type        = string
}

variable "automation_scheduler_group_name" {
  description = "EventBridge Scheduler group of agent automations; the governance worker deletes timers owned by erased threads."
  type        = string
}

variable "detailed_metrics_enabled" {
  description = "Whether API Gateway detailed CloudWatch metrics are enabled for the default route and E2E fixture routes."
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

variable "e2e_callback_fixture_enabled" {
  description = "Whether to expose the deterministic HTTP callback fixture used only by deployed E2E tests."
  type        = bool
  default     = false

  validation {
    condition     = !var.e2e_callback_fixture_enabled || var.test_fixtures_enabled
    error_message = "The E2E HTTP callback fixture may be enabled only when test_fixtures_enabled is true."
  }
}

variable "e2e_mcp_fixture_enabled" {
  description = "Whether to expose the deterministic MCP fixture used only by deployed E2E tests."
  type        = bool
  default     = false

  validation {
    condition     = !var.e2e_mcp_fixture_enabled || var.test_fixtures_enabled
    error_message = "The E2E MCP fixture may be enabled only when test_fixtures_enabled is true."
  }
}

variable "events_table_arn" {
  description = "ARN of the append-only platform events DynamoDB table."
  type        = string
}

variable "events_table_name" {
  description = "Name of the append-only platform events DynamoDB table."
  type        = string
}

variable "log_retention_in_days" {
  description = "CloudWatch retention for the API Lambda, governance worker, and API Gateway access log groups."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a CloudWatch Logs retention value."
  }
}

variable "evaluation_queue_arn" {
  description = "ARN of the agent-runtime evaluation FIFO queue the API enqueues evaluation jobs onto."
  type        = string
}

variable "evaluation_queue_url" {
  description = "URL of the agent-runtime evaluation FIFO queue the API enqueues evaluation jobs onto."
  type        = string
}

variable "usage_table_arn" {
  description = "ARN of the platform usage DynamoDB table."
  type        = string
}

variable "usage_table_name" {
  description = "Name of the platform usage DynamoDB table."
  type        = string
}

variable "model_credentials" {
  description = "Bring-your-own model keys: the providers organizations may store their own key for, how the dedicated KMS key that seals those keys is retained, and the model gateway task role, the only principal the key lets decrypt them. Null leaves the routes refusing every request and creates no key."
  type = object({
    deletion_protection_enabled = bool
    gateway_role_arn            = optional(string)
    kms_deletion_window_in_days = number
    providers                   = list(string)
  })
  default = null

  validation {
    condition = var.model_credentials == null || (
      length(try(var.model_credentials.providers, [])) > 0 &&
      length(setsubtract(try(var.model_credentials.providers, []), ["openai", "openrouter"])) == 0 &&
      length(distinct(try(var.model_credentials.providers, []))) == length(try(var.model_credentials.providers, []))
    )
    error_message = "model_credentials.providers must list openai or openrouter at most once each, and at least one."
  }
}
variable "governance_bucket_arn" {
  description = "ARN of the Object Lock bucket for governance exports."
  type        = string
}

variable "governance_bucket_name" {
  description = "Name of the Object Lock bucket for governance exports."
  type        = string
}

variable "legacy_governance_bucket_arns" {
  description = "Legacy governance bucket ARNs retained for immutable export reads and cleanup during an account-local naming cutover."
  type        = list(string)
  default     = []
}

variable "legacy_governance_bucket_names" {
  description = "Legacy governance bucket names accepted for persisted immutable export references during an account-local naming cutover."
  type        = list(string)
  default     = []
}

variable "governance_signing_key_arn" {
  description = "Asymmetric KMS key used to sign immutable audit manifests."
  type        = string
}

variable "jwt_audience" {
  description = "JWT audience accepted by application-level authentication alongside opaque API keys."
  type        = string

  validation {
    condition     = trimspace(var.jwt_audience) != ""
    error_message = "jwt_audience must not be empty."
  }
}

variable "jwt_claim_profile" {
  description = "JWT claim compatibility profile: auto preserves the configured legacy issuer, while platform enforces the handwritten issuer schema."
  type        = string
  default     = "auto"

  validation {
    condition     = contains(["auto", "cognito", "legacy", "platform"], trimspace(var.jwt_claim_profile))
    error_message = "jwt_claim_profile must be auto, cognito, legacy, or platform."
  }
}

variable "jwt_issuer" {
  description = "HTTPS JWT issuer accepted by application-level authentication alongside opaque API keys."
  type        = string

  validation {
    condition     = can(regex("^https://[^/[:space:]]+", trimspace(var.jwt_issuer)))
    error_message = "jwt_issuer must be a non-empty HTTPS issuer URL."
  }
}

variable "memory_api_function_name" {
  description = "Function name of the memory API Lambda integrated with the unified gateway."
  type        = string

  validation {
    condition     = trimspace(var.memory_api_function_name) != ""
    error_message = "memory_api_function_name must not be empty."
  }
}

variable "oauth_apps_json" {
  description = "Platform OAuth application registry used to construct provider authorization URLs."
  type        = string
  sensitive   = true

  validation {
    condition     = trimspace(var.oauth_apps_json) != ""
    error_message = "oauth_apps_json must not be empty."
  }
}

variable "oauth_return_origins" {
  description = "Exact HTTPS origins the provider OAuth callback may redirect the browser to (authorization returnTo). Empty disables returnTo redirects."
  type        = list(string)
  default     = []
}

variable "model_gateway_base_url" {
  description = "Private model gateway origin used by Brain answers; empty when the model runtime is disabled."
  type        = string
  default     = ""
}

variable "model_gateway_token_issuer" {
  description = "Brain model token issuer Lambda (arn, function_name) the API mints gateway tokens with; null when the agent runtime is disabled."
  type = object({
    arn           = string
    function_name = string
  })
  default = null
}

variable "model_grants_parameter_arn" {
  description = "SSM SecureString parameter ARN holding the operator model grants JSON; the API admits models its operator grants list. Empty when the model runtime is disabled."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.model_grants_parameter_arn) == "" ||
      can(regex("^arn:[^:]+:ssm:[^:]+:[0-9]{12}:parameter/.+$", trimspace(var.model_grants_parameter_arn)))
    )
    error_message = "model_grants_parameter_arn must be empty or an SSM parameter ARN."
  }
}

variable "memory_api_invoke_arn" {
  description = "Invoke ARN of the memory API Lambda integrated with the unified gateway."
  type        = string

  validation {
    condition     = trimspace(var.memory_api_invoke_arn) != ""
    error_message = "memory_api_invoke_arn must not be empty."
  }
}

variable "memory_erasure_function_arn" {
  description = "ARN of the internal memory provider-erasure Lambda."
  type        = string
  validation {
    condition     = trimspace(var.memory_erasure_function_arn) != ""
    error_message = "memory_erasure_function_arn must not be empty."
  }
}

variable "memory_erasure_function_name" {
  description = "Name of the internal memory provider-erasure Lambda."
  type        = string
  validation {
    condition     = trimspace(var.memory_erasure_function_name) != ""
    error_message = "memory_erasure_function_name must not be empty."
  }
}

variable "brain_erasure_function_arn" {
  description = "ARN of the internal Brain provider-erasure Lambda."
  type        = string
  validation {
    condition     = trimspace(var.brain_erasure_function_arn) != ""
    error_message = "brain_erasure_function_arn must not be empty."
  }
}

variable "brain_erasure_function_name" {
  description = "Name of the internal Brain provider-erasure Lambda."
  type        = string
  validation {
    condition     = trimspace(var.brain_erasure_function_name) != ""
    error_message = "brain_erasure_function_name must not be empty."
  }
}

variable "memory_jwt_audience" {
  description = "JWT audiences accepted by application-level memory authentication."
  type        = list(string)

  validation {
    condition = (
      length(var.memory_jwt_audience) > 0 &&
      alltrue([for value in var.memory_jwt_audience : trimspace(value) != ""])
    )
    error_message = "memory_jwt_audience must contain at least one non-empty audience."
  }
}

variable "memory_jwt_issuer" {
  description = "JWT issuer accepted by application-level memory authentication."
  type        = string

  validation {
    condition     = can(regex("^https://[^/[:space:]]+", trimspace(var.memory_jwt_issuer)))
    error_message = "memory_jwt_issuer must be a non-empty HTTPS issuer URL."
  }
}

variable "memory_jwt_jwks_uri" {
  description = "Optional JWKS URI for memory JWT identity validation when it is not issuer-relative."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.memory_jwt_jwks_uri) == "" ||
      can(regex("^https://[^/[:space:]]+", trimspace(var.memory_jwt_jwks_uri)))
    )
    error_message = "memory_jwt_jwks_uri must be empty or an HTTPS URL."
  }
}

variable "reserved_concurrency" {
  description = "Reserved Lambda concurrency for the tenancy and lifecycle API integration, or -1 for unreserved concurrency."
  type        = number
  default     = 20

  validation {
    condition = (
      var.reserved_concurrency == -1 ||
      (
        var.reserved_concurrency >= 1 &&
        var.reserved_concurrency <= 1000 &&
        floor(var.reserved_concurrency) == var.reserved_concurrency
      )
    )
    error_message = "reserved_concurrency must be -1 or an integer between 1 and 1000."
  }
}

variable "network" {
  description = "VPC and private subnets the API runs in to reach Brain OpenSearch, or null when Brain query infrastructure is disabled."
  type = object({
    private_subnet_ids = list(string)
    vpc_id             = string
  })
  default = null
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone containing domain_name."
  type        = string

  validation {
    condition     = trimspace(var.route53_zone_id) != ""
    error_message = "route53_zone_id must not be empty."
  }
}

variable "runtime_api_function_name" {
  description = "Function name of the hosted-agent runtime API Lambda integrated with the unified gateway."
  type        = string

  validation {
    condition     = trimspace(var.runtime_api_function_name) != ""
    error_message = "runtime_api_function_name must not be empty."
  }
}

variable "runtime_api_invoke_arn" {
  description = "Invoke ARN of the hosted-agent runtime API Lambda integrated with the unified gateway."
  type        = string

  validation {
    condition     = trimspace(var.runtime_api_invoke_arn) != ""
    error_message = "runtime_api_invoke_arn must not be empty."
  }
}

variable "tags" {
  description = "Additional resource tags."
  type        = map(string)
  default     = {}
}

variable "test_fixtures_enabled" {
  description = "Whether deployed E2E test fixtures (HTTP callback and MCP) are permitted in this deployment."
  type        = bool
}

variable "throttling_burst_limit" {
  description = "Maximum HTTP API request burst, from operations.public_api_throttle."
  type        = number
}

variable "throttling_rate_limit" {
  description = "Steady-state HTTP API requests per second, from operations.public_api_throttle."
  type        = number
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
  description = "JSON-encoded operations.tenant_limit_defaults read by the API Lambdas."
  type        = string
}

variable "oauth_public_origin" {
  description = "Exact https origin of the channel/provider public API serving OAuth callbacks and client metadata."
  type        = string
  default     = ""
  nullable    = false
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
