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
  description = "S3 bucket containing the platform API Lambda bundle."
  type        = string
}

variable "artifact_key" {
  description = "S3 key containing the platform API Lambda bundle."
  type        = string
}

variable "artifact_version" {
  description = "Immutable S3 object version for the platform API Lambda bundle."
  type        = string
}

variable "answer_model" {
  description = "Platform model route used to compose Brain ask answers; the Brain token issuer must list it."
  type        = string
  default     = "openai/gpt-4o-mini"

  validation {
    condition     = trimspace(var.answer_model) != ""
    error_message = "answer_model must not be empty."
  }
}

variable "model_gateway_base_url" {
  description = "Private model gateway origin; clients append /v1."
  type        = string
}

variable "model_gateway_fallback_ids" {
  description = "Fallback model ids Brain gateway calls without explicit fallbacks request (DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS); the Brain token issuer must admit them."
  type        = list(string)
}

variable "model_gateway_token_issuer" {
  description = "Brain model token issuer Lambda (arn, function_name) the Brain index worker mints gateway tokens with."
  type = object({
    arn           = string
    function_name = string
  })
}

variable "aws_native_enabled" {
  description = "Whether Brain runtimes use the AWS-native OpenSearch provider on opensearch_domain_arn/opensearch_endpoint."
  type        = bool
  default     = true
}

variable "content_bucket_arn" {
  description = "ARN of the versioned platform bucket containing Brain evidence."
  type        = string
}

variable "content_bucket_name" {
  description = "Name of the versioned platform bucket containing Brain evidence."
  type        = string
}

variable "legacy_content_bucket_arns" {
  description = "Legacy Brain content bucket ARNs retained for reads and cleanup during a naming cutover."
  type        = list(string)
  default     = []
}

variable "legacy_content_bucket_names" {
  description = "Legacy Brain content bucket names accepted by runtime boundary checks during a naming cutover."
  type        = list(string)
  default     = []
}

variable "data_kms_key_arn" {
  description = "Shared platform data KMS key ARN protecting Brain evidence objects (SSE-KMS) and the provider connection credentials that managed Brain sources read."
  type        = string
}

variable "document_extraction_function" {
  description = "Document extraction Lambda (arn, function_name) the Brain index worker invokes to extract PDF and HTML text."
  type = object({
    arn           = string
    function_name = string
  })
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
  description = "Platform environment name."
  type        = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be a lowercase name of at most 16 characters."
  }
}

variable "index_worker_maximum_concurrency" {
  description = "Maximum concurrent brain-index-worker invocations polling the brain-index queue."
  type        = number
  default     = 20
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

variable "event_bus_name" {
  description = "Platform semantic EventBridge bus name."
  type        = string
}

variable "log_retention_in_days" {
  description = "CloudWatch log retention for brain runtime log groups."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a CloudWatch Logs retention value."
  }
}

variable "memory_erasure_function_arn" {
  description = "ARN of the internal memory erasure Lambda used for Brain-derived memory purge."
  type        = string
}

variable "memory_erasure_function_name" {
  description = "Name of the internal memory erasure Lambda used for Brain-derived memory purge."
  type        = string
}

variable "opensearch_domain_arn" {
  description = "ARN of the OpenSearch domain hosting Brain indexes (brain-*); may be shared with memory."
  type        = string
  default     = ""
  validation {
    condition     = !var.aws_native_enabled || startswith(var.opensearch_domain_arn, "arn:")
    error_message = "opensearch_domain_arn is required when aws_native_enabled is true."
  }
}

variable "opensearch_endpoint" {
  description = "HTTPS origin of the OpenSearch domain; Brain search targets must catalog this endpoint."
  type        = string
  default     = ""
  validation {
    condition     = !var.aws_native_enabled || startswith(var.opensearch_endpoint, "https://")
    error_message = "opensearch_endpoint must be an https:// origin when aws_native_enabled is true."
  }
}

variable "private_subnet_ids" {
  description = "Private subnets used by Brain workers."
  type        = list(string)
}

variable "tags" {
  description = "Additional resource tags."
  type        = map(string)
  default     = {}
}

variable "upload_quotas" {
  description = "Brain upload quota overrides passed as DEPLOYMENTS_AI_BRAIN_UPLOAD_QUOTAS. Null limits keep the platform defaults (DEFAULT_BRAIN_UPLOAD_QUOTAS in packages/db)."
  type = object({
    hourly_issuance = optional(object({
      caller       = optional(number)
      organization = optional(number)
    }))
    outstanding_bytes = optional(object({
      brain        = optional(number)
      caller       = optional(number)
      organization = optional(number)
    }))
    outstanding_tickets = optional(object({
      brain        = optional(number)
      caller       = optional(number)
      organization = optional(number)
    }))
  })
  default = null

  validation {
    condition = var.upload_quotas == null ? true : alltrue([
      for limit in flatten([for limits in values(var.upload_quotas) : limits == null ? [] : values(limits)]) :
      limit == null ? true : limit >= 1 && floor(limit) == limit
    ])
    error_message = "upload_quotas limits must be positive integers."
  }
}

variable "vpc_id" {
  description = "VPC hosting Brain workers."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}
