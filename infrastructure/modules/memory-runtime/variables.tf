variable "alarms_enabled" {
  description = "Whether the module creates its CloudWatch alarms. False creates none, for an installation whose ops alerts reach no one."
  type        = bool
  default     = true
}

variable "alarm_topic_arn" {
  description = "Ops alerts SNS topic ARN notified when an alarm enters or leaves the ALARM state."
  type        = string
}

variable "aws_native_enabled" {
  description = "Whether memory runtimes use the AWS-native OpenSearch placement on opensearch_domain_arn/opensearch_endpoint."
  type        = bool
  default     = true
}

variable "log_retention_in_days" {
  description = "CloudWatch log retention for memory runtime log groups."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a CloudWatch Logs retention value."
  }
}

variable "opensearch_domain_arn" {
  description = "ARN of the OpenSearch domain hosting memory indexes (memory-*); may be shared with Brain."
  type        = string
  default     = ""
  validation {
    condition     = !var.aws_native_enabled || startswith(var.opensearch_domain_arn, "arn:")
    error_message = "opensearch_domain_arn is required when aws_native_enabled is true."
  }
}

variable "opensearch_endpoint" {
  description = "HTTPS origin of the OpenSearch domain; memory search targets must catalog this endpoint."
  type        = string
  default     = ""
  validation {
    condition     = !var.aws_native_enabled || startswith(var.opensearch_endpoint, "https://")
    error_message = "opensearch_endpoint must be an https:// origin when aws_native_enabled is true."
  }
}

variable "artifact_bucket" {
  description = "S3 bucket containing the bundled memory runtime artifact."
  type        = string
}

variable "artifact_key" {
  description = "S3 key containing the bundled memory runtime artifact."
  type        = string
}

variable "artifact_version" {
  description = "Immutable S3 object version for the memory runtime artifact."
  type        = string
}

variable "model_gateway_base_url" {
  description = "Private model gateway origin; clients append /v1."
  type        = string
}

variable "model_gateway_token_issuer" {
  description = "Memory model token issuer Lambda (arn, function_name) the memory runtimes mint gateway tokens with."
  type = object({
    arn           = string
    function_name = string
  })
}

variable "blob_bucket_arn" {
  description = "ARN of the private platform bucket containing referenced message and memory bodies."
  type        = string
}

variable "blob_bucket_name" {
  description = "Name of the private platform bucket containing referenced message and memory bodies."
  type        = string
}

variable "legacy_blob_bucket_arns" {
  description = "Legacy memory blob bucket ARNs retained for reads and cleanup during a naming cutover."
  type        = list(string)
  default     = []
}

variable "legacy_blob_bucket_names" {
  description = "Legacy memory blob bucket names accepted by runtime boundary checks during a naming cutover."
  type        = list(string)
  default     = []
}

variable "dynamodb_table_arns" {
  description = "Platform DynamoDB table ARNs keyed by logical table name."
  type        = map(string)
}

variable "data_kms_key_arn" {
  description = "Shared platform data KMS key ARN that encrypts referenced message and memory bodies (SSE-KMS) and seals memory page cursors."
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

variable "dynamodb_table_names" {
  description = "Platform DynamoDB table names keyed by logical table name."
  type        = map(string)
}

variable "embedding_dimensions" {
  description = "Memory search embedding dimensionality."
  type        = number
  default     = 1536
}

variable "embedding_model" {
  description = "Platform model route used to embed memory content."
  type        = string
  default     = "openai/text-embedding-3-small"

  validation {
    condition     = trimspace(var.embedding_model) != ""
    error_message = "embedding_model must not be empty."
  }
}

variable "rerank_model" {
  description = "Platform model route used to rerank hybrid-rerank-v1 memory candidates; the memory token issuer must list it."
  type        = string
  default     = "openai/gpt-4o-mini"

  validation {
    condition     = trimspace(var.rerank_model) != ""
    error_message = "rerank_model must not be empty."
  }
}

variable "flush_model" {
  description = "Platform model route memory flushes use in place of the run's agent model when the run's environment admits it; null keeps the agent's model. The memory token issuer admits it under each environment's model policy."
  type        = string
  default     = null

  validation {
    condition     = var.flush_model == null || try(trimspace(var.flush_model) != "", false)
    error_message = "flush_model must be null or a non-empty model route."
  }
}

variable "model_gateway_fallback_ids" {
  description = "Fallback model ids memory gateway calls without explicit fallbacks request (DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS); the memory token issuer must admit them."
  type        = list(string)
}

variable "environment" {
  description = "Platform environment name."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be a lowercase name of at most 16 characters."
  }
}

variable "event_bus_name" {
  description = "Platform semantic EventBridge bus name."
  type        = string
}

variable "index_worker_maximum_concurrency" {
  description = "Maximum concurrent memory index worker invocations polling the memory-index queue."
  type        = number
  default     = 10
  nullable    = false

  validation {
    condition = (
      floor(var.index_worker_maximum_concurrency) == var.index_worker_maximum_concurrency &&
      var.index_worker_maximum_concurrency >= 2 &&
      var.index_worker_maximum_concurrency <= 1000
    )
    error_message = "index_worker_maximum_concurrency must be an integer between 2 and 1000."
  }
}

variable "jwt_audience" {
  description = "JWT audiences accepted by the public memory API."
  type        = list(string)
}

variable "jwt_issuer" {
  description = "HTTPS JWT issuer for the public memory API."
  type        = string
}

variable "jwt_jwks_uri" {
  description = "Optional JWKS URI when the memory JWT keys are not issuer-relative."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.jwt_jwks_uri) == "" ||
      can(regex("^https://[^/[:space:]]+", trimspace(var.jwt_jwks_uri)))
    )
    error_message = "jwt_jwks_uri must be empty or an HTTPS URL."
  }
}

variable "membership_keyring" {
  description = "Optional complete versioned HMAC keyring for memory target membership. Retain every historical key referenced by durable membership records."
  type = object({
    current_version = number
    keys            = map(string)
  })
  default   = null
  nullable  = true
  sensitive = true

  validation {
    condition = var.membership_keyring == null || try(
      var.membership_keyring.current_version >= 1 &&
      floor(var.membership_keyring.current_version) == var.membership_keyring.current_version &&
      contains(keys(var.membership_keyring.keys), tostring(var.membership_keyring.current_version)) &&
      alltrue([
        for version, key in var.membership_keyring.keys :
        can(regex("^[1-9][0-9]*$", version)) &&
        tostring(tonumber(version)) == version &&
        length(trimspace(key)) >= 32
      ]),
      false
    )
    error_message = "membership_keyring must contain its positive integer current_version and every versioned key must be at least 32 characters."
  }
}

variable "reconciliation_scopes" {
  description = "Optional tenant scopes that get a five-minute drift repair between canonical memory and the organization's search target. Search works without it: writes queue their own index jobs, and the operation reconciler retries due index jobs for every organization."
  type = list(object({
    environment_id  = string
    organization_id = string
    project_id      = string
    workspace_id    = optional(string)
  }))
  validation {
    condition = alltrue([
      for scope in var.reconciliation_scopes :
      can(regex("^[0-7][0-9A-HJKMNP-TV-Z]{25}$", scope.environment_id)) &&
      can(regex("^[0-7][0-9A-HJKMNP-TV-Z]{25}$", scope.organization_id)) &&
      can(regex("^[0-7][0-9A-HJKMNP-TV-Z]{25}$", scope.project_id)) &&
      try(scope.workspace_id == null ? true : can(regex("^[0-7][0-9A-HJKMNP-TV-Z]{25}$", scope.workspace_id)), true)
    ])
    error_message = "reconciliation_scopes must use canonical ULID identifiers."
  }
}

variable "tags" {
  description = "Additional resource tags."
  type        = map(string)
  default     = {}
}

variable "network" {
  description = "VPC and private subnets the memory Lambdas run in to reach the private model gateway, or null to run outside a VPC."
  type = object({
    private_subnet_ids = list(string)
    vpc_id             = string
  })
  default = null
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
  description = "JSON-encoded operations.tenant_limit_defaults read by the memory API."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}
