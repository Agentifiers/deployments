variable "account_id" {
  description = "AWS account that owns the agent email stack."
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

variable "legacy_bucket_arns" {
  description = "Legacy agent-email bucket ARNs retained for bounded reads and cleanup during an account-local naming cutover."
  type        = list(string)
  default     = []
}

variable "legacy_bucket_names" {
  description = "Legacy agent-email bucket names accepted for persisted message content during an account-local naming cutover."
  type        = list(string)
  default     = []
}

variable "agent_run_queue_arn" {
  description = "Canonical agent run FIFO queue ARN. When set with agent_run_queue_url and a runtime artifact, inbound email processing is deployed."
  type        = string
  default     = ""

  validation {
    condition     = (trimspace(var.agent_run_queue_arn) == "") == (trimspace(var.agent_run_queue_url) == "")
    error_message = "agent_run_queue_arn and agent_run_queue_url must either both be set or both be empty."
  }
}

variable "agent_run_queue_url" {
  description = "Canonical agent run FIFO queue URL."
  type        = string
  default     = ""
}

variable "api_jwks_uri" {
  description = "Optional explicit JWKS URI for hosted agent-email JWT authentication."
  type        = string
  default     = ""
}

variable "api_jwt_audience" {
  description = "JWT audience accepted by the hosted agent-email API alongside opaque platform API keys."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.runtime_artifact_bucket) == "" || trimspace(var.api_jwt_audience) != ""
    error_message = "api_jwt_audience is required when the agent-email runtime artifact is configured."
  }
}

variable "api_jwt_claim_profile" {
  description = "JWT claim compatibility profile for the hosted agent-email API."
  type        = string
  default     = "auto"

  validation {
    condition     = contains(["auto", "cognito", "legacy", "platform"], trimspace(var.api_jwt_claim_profile))
    error_message = "api_jwt_claim_profile must be auto, cognito, legacy, or platform."
  }
}

variable "api_jwt_issuer" {
  description = "HTTPS JWT issuer used by hosted agent-email authentication."
  type        = string
  default     = ""

  validation {
    condition = (
      trimspace(var.runtime_artifact_bucket) == "" ||
      can(regex("^https://[^/[:space:]]+", trimspace(var.api_jwt_issuer)))
    )
    error_message = "api_jwt_issuer must be a non-empty HTTPS issuer when the agent-email runtime artifact is configured."
  }
}

variable "artifact_bucket_name" {
  description = "Name of the platform artifact bucket used for captured inbound email attachments."
  type        = string
}

variable "activate_receipt_rule_set" {
  description = "Explicitly activate the module-owned SES receipt rule set in this account and region."
  type        = bool
  default     = false
}

variable "domain" {
  description = "Hosted domain for platform-managed agent inboxes."
  type        = string
}

variable "dynamodb_table_arns" {
  description = "Canonical platform DynamoDB table ARNs."
  type        = map(string)
}

variable "data_kms_key_arn" {
  description = "Shared platform data KMS key ARN. It encrypts the primary-region SNS topics and the attachment artifacts that inbound email captures, and seals hosted API idempotency responses."
  type        = string

  validation {
    condition     = can(regex("^arn:aws[a-z-]*:kms:[^:]+:[0-9]{12}:key/", trimspace(var.data_kms_key_arn)))
    error_message = "data_kms_key_arn must be a valid KMS key ARN."
  }
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

variable "disable_account_suppression" {
  description = "Disable SES account-level suppression only in a dedicated agent-email sending account."
  type        = bool
  default     = false
}

variable "document_extraction_function" {
  description = "Document extraction Lambda (arn, function_name) the inbound roles invoke to read the text of captured documents."
  type = object({
    arn           = string
    function_name = string
  })
}

variable "enable_runtime" {
  description = "Explicitly enable the managed agent-email API and workers when immutable artifacts and runtime dependencies are available."
  type        = bool
  default     = false
}

variable "deletion_protection_enabled" {
  description = "Whether the email bucket is protected from force_destroy."
  type        = bool
}

variable "end_user_subject_key_arn" {
  description = "SSM SecureString parameter ARN of the end-user subject HMAC key. The API and inbound runtimes key mail correspondents with it so end-user erasure can find their mail. Set exactly when enable_inbound_runtime is true, because the canonical agent runtime owns the key."
  type        = string

  validation {
    condition     = (trimspace(var.end_user_subject_key_arn) != "") == var.enable_inbound_runtime
    error_message = "end_user_subject_key_arn must be set exactly when enable_inbound_runtime is true."
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

variable "enable_catch_all_receiving" {
  description = "Authorize the module-owned catch-all receipt rule to be activated in a dedicated agent-email account and region."
  type        = bool
  default     = false
}

variable "enable_inbound_runtime" {
  description = "Deploy the managed inbound worker when the canonical agent runtime is enabled."
  type        = bool
  default     = false
}

variable "events_stream_arn" {
  description = "Events table stream ARN for optional semantic-event dispatch wiring."
  type        = string
  default     = ""
}

variable "ingress_attachment_capture_role_arn" {
  description = "Tenant-tagged role the inbound roles assume with a binding's organization, project, and environment to store that binding's captured attachments. Null when no inbound role exists."
  type        = string
}

variable "lambda_function_arns" {
  description = "Optional worker Lambda ARNs keyed by inbound, send, events, maintenance, and stream-dispatcher."
  type        = map(string)
  default     = {}

  validation {
    condition = (
      alltrue([
        for key in keys(var.lambda_function_arns) : contains(
          ["events", "inbound", "maintenance", "send", "stream-dispatcher"],
          key,
        )
      ]) &&
      alltrue([for arn in values(var.lambda_function_arns) : trimspace(arn) != ""])
    )
    error_message = "lambda_function_arns contains an unsupported worker key or empty ARN."
  }
}

variable "lambda_role_names" {
  description = "Optional worker Lambda execution role names keyed like lambda_function_arns. Required before event mappings are created."
  type        = map(string)
  default     = {}

  validation {
    condition = (
      alltrue([
        for key in keys(var.lambda_role_names) : contains(
          ["events", "inbound", "maintenance", "send", "stream-dispatcher"], key,
        )
      ]) &&
      alltrue([for role_name in values(var.lambda_role_names) : trimspace(role_name) != ""])
    )
    error_message = "lambda_role_names contains an unsupported worker key or empty role name."
  }
}

variable "log_retention_in_days" {
  description = "CloudWatch retention for the managed agent-email runtime Lambda log groups."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a CloudWatch Logs retention value."
  }
}

variable "manage_dns" {
  description = "Whether OpenTofu should create authoritative DNS records for the hosted domain."
  type        = bool
  default     = false
}

variable "region" {
  description = "Primary SES inbound and sending region."
  type        = string
}

variable "regional_event_topic_kms_key_arns" {
  description = "Pre-provisioned regional KMS key ARNs used by dynamically managed secondary-region SNS topics."
  type        = map(string)
  default     = {}
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone ID that receives the hosted-domain records when manage_dns is true."
  type        = string
  default     = ""

  validation {
    condition     = !var.manage_dns || can(regex("^Z[A-Z0-9]+$", trimspace(var.route53_zone_id)))
    error_message = "route53_zone_id must be a Route 53 hosted zone ID when manage_dns is true."
  }
}

variable "runtime_artifact_bucket" {
  description = "S3 bucket containing the bundled agent-email API and inbound Lambda artifact."
  type        = string
  default     = ""

  validation {
    condition = (
      (trimspace(var.runtime_artifact_bucket) == "") == (trimspace(var.runtime_artifact_key) == "") &&
      (trimspace(var.runtime_artifact_bucket) == "") == (trimspace(var.runtime_artifact_version) == "")
    )
    error_message = "runtime_artifact_bucket, runtime_artifact_key, and runtime_artifact_version must either all be set or all be empty."
  }
}

variable "runtime_artifact_key" {
  description = "S3 key containing the bundled agent-email Lambda artifact."
  type        = string
  default     = ""
}

variable "runtime_artifact_version" {
  description = "Immutable S3 object version for the bundled agent-email Lambda artifact."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.runtime_artifact_version) == "" || lower(trimspace(var.runtime_artifact_version)) != "null"
    error_message = "runtime_artifact_version must be an immutable, non-null object version when set."
  }
}

variable "tags" {
  description = "Additional tags applied to agent email resources."
  type        = map(string)
  default     = {}
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
  description = "JSON-encoded operations.tenant_limit_defaults read by the agent-email API."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}
