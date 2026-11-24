variable "environment" {
  description = "Deployment name used only for resource naming, tags, and SSM paths."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be a lowercase name of at most 16 characters."
  }
}

variable "aws_account_id" {
  description = "AWS account ID that owns the platform deployment."
  type        = string
}

variable "aws_region" {
  description = "AWS region of the platform deployment."
  type        = string
}

variable "tags" {
  description = "Additional tags applied to platform resources."
  type        = map(string)
  default     = {}
}

variable "operations" {
  description = "Operational posture of the deployment: protection, availability, monitoring, sizing, capacity, edge protection, operator access, test fixtures, retention, ops alert routing, the public API stage throttle, and per-organization limit defaults. Every field is required so each deployment states its posture explicitly; an empty ops alert channel or email leaves that route unset."
  type = object({
    deletion_protection             = bool
    secret_recovery_window_days     = number
    kms_deletion_window_days        = number
    high_availability               = bool
    enhanced_monitoring             = bool
    compact_sizing                  = bool
    fargate_spot                    = bool
    web_application_firewall        = bool
    shared_search_domain            = bool
    dedicated_public_load_balancers = bool
    operator_shell_access           = bool
    test_fixtures                   = bool
    log_retention_days              = number
    service_log_retention_days      = number
    failure_retention_days          = number
    query_result_retention_days     = number
    observability_retention_days    = number
    backup_retention_days           = number
    webhook_delivery_retention_days = number
    ops_alerts_slack_channel_id     = string
    ops_alerts_email                = string
    public_api_throttle = object({
      rate_limit  = number
      burst_limit = number
    })
    tenant_limit_defaults = object({
      api_requests_per_second = number
      api_request_burst       = number
      concurrent_runs         = number
      active_sandboxes        = number
    })
  })

  validation {
    condition = (
      var.operations.secret_recovery_window_days == 0 ||
      (var.operations.secret_recovery_window_days >= 7 && var.operations.secret_recovery_window_days <= 30)
    )
    error_message = "operations.secret_recovery_window_days must be 0 or between 7 and 30."
  }

  validation {
    condition     = var.operations.kms_deletion_window_days >= 7 && var.operations.kms_deletion_window_days <= 30
    error_message = "operations.kms_deletion_window_days must be between 7 and 30."
  }

  validation {
    condition = alltrue([
      for days in [var.operations.log_retention_days, var.operations.service_log_retention_days] :
      contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], days)
    ])
    error_message = "operations log retention values must be CloudWatch Logs retention periods."
  }

  validation {
    condition = alltrue([
      for days in [
        var.operations.failure_retention_days,
        var.operations.query_result_retention_days,
        var.operations.observability_retention_days,
        var.operations.backup_retention_days,
        var.operations.webhook_delivery_retention_days,
      ] : floor(days) == days && days >= 1
    ])
    error_message = "operations retention values must be positive whole days."
  }

  validation {
    condition     = var.operations.ops_alerts_slack_channel_id == "" || can(regex("^[CG][A-Z0-9]{8,}$", var.operations.ops_alerts_slack_channel_id))
    error_message = "operations.ops_alerts_slack_channel_id must be empty or a Slack channel ID such as C0123456789."
  }

  validation {
    condition     = var.operations.ops_alerts_email == "" || can(regex("^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$", var.operations.ops_alerts_email))
    error_message = "operations.ops_alerts_email must be empty or an email address."
  }

  validation {
    condition = (
      floor(var.operations.public_api_throttle.rate_limit) == var.operations.public_api_throttle.rate_limit &&
      floor(var.operations.public_api_throttle.burst_limit) == var.operations.public_api_throttle.burst_limit &&
      var.operations.public_api_throttle.rate_limit >= 1 &&
      var.operations.public_api_throttle.burst_limit >= var.operations.public_api_throttle.rate_limit
    )
    error_message = "operations.public_api_throttle needs whole-number limits with rate_limit >= 1 and burst_limit >= rate_limit."
  }

  validation {
    condition = alltrue([
      for limit in [
        { value = var.operations.tenant_limit_defaults.api_requests_per_second, min = 1, max = 500 },
        { value = var.operations.tenant_limit_defaults.api_request_burst, min = 1, max = 1000 },
        { value = var.operations.tenant_limit_defaults.concurrent_runs, min = 1, max = 256 },
        { value = var.operations.tenant_limit_defaults.active_sandboxes, min = 0, max = 256 },
      ] : floor(limit.value) == limit.value && limit.value >= limit.min && limit.value <= limit.max
    ])
    error_message = "operations.tenant_limit_defaults must be whole numbers: api_requests_per_second 1-500, api_request_burst 1-1000, concurrent_runs 1-256, active_sandboxes 0-256."
  }

  validation {
    condition = (
      var.operations.tenant_limit_defaults.api_request_burst >= var.operations.tenant_limit_defaults.api_requests_per_second &&
      var.operations.tenant_limit_defaults.api_requests_per_second <= var.operations.public_api_throttle.rate_limit
    )
    error_message = "operations.tenant_limit_defaults.api_request_burst must be at least api_requests_per_second, which must not exceed public_api_throttle.rate_limit."
  }
}

variable "default_model_spend_ceiling_usd_micros" {
  description = "Monthly operator-funded model spend, in USD micros, that an organization may use when no grant sets its own ceiling. Spend on the organization's own provider keys never counts. Null leaves it unlimited."
  type        = number
  default     = null
}

variable "organization_creation_quota_per_principal" {
  description = "Organizations one person may create over their lifetime. Erasing an organization does not give one back, and platform administrators are exempt. Null allows any number."
  type        = number
  default     = null
}

variable "ops_alerts_notifier_artifact_bucket" {
  description = "S3 bucket containing the ops alerts notifier Lambda artifact."
  type        = string
}

variable "ops_alerts_notifier_artifact_key" {
  description = "S3 object key for the ops alerts notifier Lambda artifact."
  type        = string
}

variable "ops_alerts_notifier_artifact_version" {
  description = "Immutable S3 object version for the ops alerts notifier Lambda artifact."
  type        = string
}

variable "legacy_account_local_buckets_enabled" {
  description = "Keep pre-cutover account-local artifact, agent-email, and governance buckets in bounded runtime and governance read/cleanup paths."
  type        = bool
  default     = false
}

variable "availability_zones" {
  description = "Availability zones of the shared private runtime VPC."
  type        = list(string)
}

variable "network_cidr_block" {
  description = "CIDR block of the shared private runtime VPC."
  type        = string
  default     = "10.42.0.0/16"
}

variable "network_nat_mode" {
  description = "Private subnet egress mode of the shared VPC: gateway (managed NAT gateways) or instance (NAT instances)."
  type        = string
  default     = "gateway"
}

variable "network_nat_instance_ami_id" {
  description = "Pinned NAT instance AMI when network_nat_mode is instance."
  type        = string
  default     = ""
}

variable "network_nat_instance_type" {
  description = "NAT instance type when network_nat_mode is instance."
  type        = string
  default     = "t4g.nano"
}

variable "network_single_nat_gateway" {
  description = "Whether all private subnets share one NAT egress path instead of one per availability zone."
  type        = bool
  default     = false
}

variable "lifecycle_markers_enabled" {
  description = "Whether event analytics and event query lifecycles are guarded by SSM markers that reject unsafe transitions."
  type        = bool
  default     = true
}

variable "iam_permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role the stack creates. Customer installs pass the policy infrastructure/bootstrap/customer creates; null sets none."
  type        = string
  default     = null
}
