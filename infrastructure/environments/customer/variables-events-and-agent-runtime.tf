variable "event_analytics_lifecycle" {
  description = "Event analytics lifecycle: absent, stopped, running, decommissioning, or destroyed. Running projects every semantic event into the operator-only Athena event log."
  type        = string
  default     = "running"

  validation {
    condition = contains([
      "absent",
      "decommissioning",
      "destroyed",
      "running",
      "stopped",
    ], var.event_analytics_lifecycle)
    error_message = "event_analytics_lifecycle must be absent, stopped, running, decommissioning, or destroyed."
  }

  validation {
    condition = (
      contains(["absent", "destroyed"], var.event_analytics_lifecycle) ||
      var.enable_platform_events
    )
    error_message = "enable_platform_events must be true while event analytics is managed."
  }

}

variable "event_analytics_extra_sources" {
  description = "EventBridge sources, such as a product's own, that event analytics records in addition to deployments-ai.platform. Publishers put canonical semantic events on the semantic_event_bus_name bus."
  type        = list(string)
  default     = []
}

variable "event_analytics_projector_artifact_bucket" {
  description = "S3 bucket containing the production event analytics projector artifact."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      contains(["absent", "destroyed"], var.event_analytics_lifecycle) ||
      try(trimspace(var.event_analytics_projector_artifact_bucket) != "", false)
    )
    error_message = "event_analytics_projector_artifact_bucket is required while event analytics is managed."
  }
}

variable "event_analytics_projector_artifact_key" {
  description = "S3 object key for the production event analytics projector artifact."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      contains(["absent", "destroyed"], var.event_analytics_lifecycle) ||
      try(trimspace(var.event_analytics_projector_artifact_key) != "", false)
    )
    error_message = "event_analytics_projector_artifact_key is required while event analytics is managed."
  }
}

variable "event_analytics_projector_artifact_version" {
  description = "Immutable S3 object version for the production event analytics projector artifact."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      contains(["absent", "destroyed"], var.event_analytics_lifecycle) ||
      try(
        trimspace(var.event_analytics_projector_artifact_version) != "" &&
        lower(trimspace(var.event_analytics_projector_artifact_version)) != "null",
        false,
      )
    )
    error_message = "A non-null event_analytics_projector_artifact_version is required while event analytics is managed."
  }
}

variable "enable_platform_events" {
  description = "Whether to create the semantic event dispatcher infrastructure."
  type        = bool
  default     = true
}

variable "event_dispatcher_artifact_bucket" {
  description = "S3 bucket containing the production event dispatcher Lambda artifact."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      !var.enable_platform_events ||
      try(trimspace(var.event_dispatcher_artifact_bucket) != "", false)
    )
    error_message = "event_dispatcher_artifact_bucket is required when enable_platform_events is true."
  }
}

variable "event_dispatcher_artifact_key" {
  description = "S3 object key for the production event dispatcher Lambda artifact."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      !var.enable_platform_events ||
      try(trimspace(var.event_dispatcher_artifact_key) != "", false)
    )
    error_message = "event_dispatcher_artifact_key is required when enable_platform_events is true."
  }
}

variable "event_dispatcher_artifact_version" {
  description = "Immutable S3 object version for the production event dispatcher Lambda artifact."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      !var.enable_platform_events ||
      try(
        trimspace(var.event_dispatcher_artifact_version) != "" &&
        lower(trimspace(var.event_dispatcher_artifact_version)) != "null",
        false,
      )
    )
    error_message = "A non-null event_dispatcher_artifact_version is required when enable_platform_events is true."
  }
}

variable "agent_runtime_enabled" {
  description = "Whether to deploy the queue-backed hosted agent runtime and the stream gateway."
  type        = bool
  default     = true

  validation {
    condition = (
      !var.agent_runtime_enabled ||
      (
        var.channel_provider_runtime_enabled &&
        var.durable_streams_enabled &&
        var.durable_streams_desired_count > 0 &&
        var.enable_platform_events &&
        var.bifrost_desired_count > 0
      )
    )
    error_message = "Agent runtime requires platform events, channel/provider, Durable Streams, and model runtimes with positive backing-service counts."
  }
}

variable "agent_observability_history_enabled" {
  description = "Whether to deploy the observability history pipeline: a Kinesis stream, Firehose, Iceberg tables in S3 Tables, and an Athena workgroup."
  type        = bool
  default     = true

  validation {
    condition     = !var.agent_observability_history_enabled || var.agent_runtime_enabled
    error_message = "agent_runtime_enabled must be true when agent_observability_history_enabled is true."
  }
}

variable "agent_observability_noncurrent_file_days" {
  description = "Days before S3 Tables deletes noncurrent observability history files; bounds tenant-erasure physical removal."
  type        = number
  default     = 3
}

variable "agent_observability_snapshot_max_age_hours" {
  description = "S3 Tables snapshot expiry age for observability history; bounds tenant-erasure physical removal."
  type        = number
  default     = 72
}

variable "agent_observability_unreferenced_file_days" {
  description = "Days before S3 Tables marks unreferenced observability history files noncurrent."
  type        = number
  default     = 3
}

variable "agent_observability_hot_enabled" {
  description = "Whether to deploy the ClickHouse hot plane that serves the observability API. Without it, every observability operation returns 503 observability_unavailable."
  type        = bool
  default     = true

  validation {
    condition     = !var.agent_observability_hot_enabled || var.agent_observability_history_enabled
    error_message = "agent_observability_history_enabled must be true when agent_observability_hot_enabled is true."
  }
}

variable "agent_observability_hot_image" {
  description = "Immutable ARM64 observability hot-plane image. The deploy tool sets it."
  type        = string
  default     = ""

  validation {
    condition     = !var.agent_observability_hot_enabled || can(regex("@sha256:[0-9a-f]{64}$", var.agent_observability_hot_image))
    error_message = "agent_observability_hot_image must use an immutable sha256 digest when agent_observability_hot_enabled is true."
  }
}

variable "agent_observability_clickhouse_ami_id" {
  description = "Optional ARM64 AMI for the ClickHouse node, such as one baked with bun run observability:clickhouse:ami:bake. Empty pins Canonical's Ubuntu 24.04 ARM64 image at the first apply, and the node installs the checksum-pinned ClickHouse packages at boot."
  type        = string
  default     = ""

  validation {
    condition     = var.agent_observability_clickhouse_ami_id == "" || can(regex("^ami-[0-9a-f]+$", var.agent_observability_clickhouse_ami_id))
    error_message = "agent_observability_clickhouse_ami_id must be empty or an AMI ID."
  }
}

variable "agent_observability_clickhouse_instance_type" {
  description = "Graviton ClickHouse instance type: a t4g size from t4g.small or any r7g size. ClickHouse caps its memory at 70 percent of the instance's RAM, so a new size needs no other change."
  type        = string
  default     = "t4g.medium"
}

variable "agent_observability_clickhouse_data_volume_size_gib" {
  description = "ClickHouse data volume size in GiB. Raise it to grow the volume online; a smaller value keeps the current size."
  type        = number
  default     = 20
}

variable "agent_observability_clickhouse_backup_retention_days" {
  description = "Days the hot plane keeps native ClickHouse backups and data-volume snapshots. Null keeps the lesser of operations.backup_retention_days and 7."
  type        = number
  default     = null
}

variable "agent_observability_hot_task_size" {
  description = "Fargate CPU units and memory in MiB of the observability hot-plane writer/API task."
  type = object({
    cpu    = number
    memory = number
  })
  default = { cpu = 256, memory = 512 }
}

variable "agent_runtime_browser_allowed_origins" {
  description = "HTTPS origins that hosted agents may target with sandbox browser tools in production."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for origin in var.agent_runtime_browser_allowed_origins :
      can(regex("^https://[^/[:space:]]+$", trimspace(origin)))
    ])
    error_message = "agent_runtime_browser_allowed_origins must contain only HTTPS origins."
  }
}

variable "agent_runtime_browser_any_public_origin" {
  description = "Let agents open any public http(s) origin with sandbox browser tools. The guest refuses every connection to a non-public address. When true, agent_runtime_browser_allowed_origins is not used."
  type        = bool
  default     = false
}

variable "agent_runtime_firecrawl_api_key_secret_arn" {
  description = "Optional Parameter Store or Secrets Manager ARN containing the API key of an external Firecrawl, used when web_tools_runtime_enabled is false."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      var.agent_runtime_firecrawl_api_key_secret_arn == null ||
      can(regex("^arn:[^:]+:(ssm:[^:]+:[0-9]{12}:parameter/|secretsmanager:[^:]+:[0-9]{12}:secret:).+$", var.agent_runtime_firecrawl_api_key_secret_arn))
    )
    error_message = "agent_runtime_firecrawl_api_key_secret_arn must be a Parameter Store or Secrets Manager ARN."
  }
}

variable "agent_runtime_firecrawl_base_url" {
  description = "HTTPS base URL of an external Firecrawl, required when web tools are enabled without the in-stack runtime."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      !var.agent_runtime_web_tools_enabled || var.web_tools_runtime_enabled ||
      try(can(regex("^https://[^[:space:]]+$", trimspace(var.agent_runtime_firecrawl_base_url))), false)
    )
    error_message = "agent_runtime_firecrawl_base_url must be an HTTPS URL when web tools are enabled without web_tools_runtime_enabled."
  }
}

variable "agent_runtime_firecrawl_job_ticket_secret_arn" {
  description = "Parameter Store or Secrets Manager ARN containing at least 32 bytes for scoped job tickets to an external Firecrawl, required when web tools are enabled without the in-stack runtime."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition = (
      !var.agent_runtime_web_tools_enabled || var.web_tools_runtime_enabled ||
      try(can(regex("^arn:[^:]+:(ssm:[^:]+:[0-9]{12}:parameter/|secretsmanager:[^:]+:[0-9]{12}:secret:).+$", var.agent_runtime_firecrawl_job_ticket_secret_arn)), false)
    )
    error_message = "agent_runtime_firecrawl_job_ticket_secret_arn must be a Parameter Store or Secrets Manager ARN when web tools are enabled without web_tools_runtime_enabled."
  }
}

variable "agent_runtime_web_tools_enabled" {
  description = "Whether hosted agents may run the web.* tools against the in-stack Firecrawl, or the external one when web_tools_runtime_enabled is false."
  type        = bool
  default     = true

  validation {
    condition     = !var.agent_runtime_web_tools_enabled || var.agent_runtime_enabled
    error_message = "agent_runtime_enabled must be true when agent_runtime_web_tools_enabled is true."
  }
}

variable "agent_runtime_artifact_bucket" {
  description = "S3 bucket containing the hosted agent runtime Lambda artifact."
  type        = string
  default     = ""

  validation {
    condition     = !var.agent_runtime_enabled || trimspace(var.agent_runtime_artifact_bucket) != ""
    error_message = "agent_runtime_artifact_bucket is required when agent_runtime_enabled is true."
  }
}

variable "agent_runtime_artifact_key" {
  description = "S3 key containing the hosted agent runtime Lambda artifact."
  type        = string
  default     = ""

  validation {
    condition     = !var.agent_runtime_enabled || trimspace(var.agent_runtime_artifact_key) != ""
    error_message = "agent_runtime_artifact_key is required when agent_runtime_enabled is true."
  }
}

variable "agent_runtime_artifact_version" {
  description = "Immutable S3 object version for the hosted agent runtime Lambda artifact."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.agent_runtime_enabled ||
      (trimspace(var.agent_runtime_artifact_version) != "" && lower(trimspace(var.agent_runtime_artifact_version)) != "null")
    )
    error_message = "A non-null agent_runtime_artifact_version is required when agent_runtime_enabled is true."
  }
}

variable "agent_runtime_legacy_webhook_signing_secret_arns" {
  description = "Secrets Manager ARNs used by legacy webhook endpoint records during migration."
  type        = list(string)
  default     = []
}

variable "agent_worker_image" {
  description = "Digest-pinned ARM64 agent worker image built from functions/worker/Dockerfile and supplied by the deploy tool."
  type        = string
  default     = ""

  validation {
    condition     = !var.agent_runtime_enabled || can(regex("@sha256:[0-9a-f]{64}$", var.agent_worker_image))
    error_message = "Set agent_worker_image to a sha256-pinned image when the agent runtime is enabled."
  }
}
