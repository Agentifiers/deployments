variable "memory_runtime_enabled" {
  description = "Whether to create the public memory API and workers."
  type        = bool
  default     = false
}

variable "memory_runtime_artifact_bucket" {
  description = "S3 bucket containing the memory runtime Lambda artifact."
  type        = string
  default     = ""
}

variable "memory_runtime_artifact_key" {
  description = "S3 key containing the memory runtime Lambda artifact."
  type        = string
  default     = ""
}

variable "memory_runtime_artifact_version" {
  description = "Immutable S3 object version for the memory runtime Lambda artifact."
  type        = string
  default     = ""
}

variable "memory_runtime_jwt_audience" {
  description = "JWT audiences accepted by the memory API unless runtime_jwt_from_platform_identity applies."
  type        = list(string)
  default     = []
}

variable "memory_runtime_jwt_issuer" {
  description = "HTTPS JWT issuer for the memory API unless runtime_jwt_from_platform_identity applies."
  type        = string
  default     = ""
}

variable "memory_runtime_jwks_uri" {
  description = "Optional JWKS URI for memory JWT validation when it is not issuer-relative."
  type        = string
  default     = ""
}

variable "memory_runtime_membership_keyring" {
  description = "Optional complete OpenTofu-owned memory membership HMAC keyring."
  type = object({
    current_version = number
    keys            = map(string)
  })
  default   = null
  sensitive = true
}

variable "memory_runtime_reconciliation_scopes" {
  description = "Optional tenant scopes that get a five-minute memory drift repair; search does not depend on it."
  type = list(object({
    environment_id  = string
    organization_id = string
    project_id      = string
    workspace_id    = optional(string)
  }))
  default = []
}

variable "memory_runtime_embedding_model" {
  description = "Model gateway route used for memory embeddings."
  type        = string
  default     = "openai/text-embedding-3-small"
}

variable "memory_runtime_rerank_model" {
  description = "Model gateway route used for memory reranking; the memory and agent-worker token issuers always admit it."
  type        = string
  default     = "openai/gpt-4o-mini"
}

variable "memory_runtime_flush_model" {
  description = "Model gateway route memory flushes use in place of the run's agent model when the run's environment admits it; null keeps the agent's model. The memory token issuer checks it against each environment's model policy, not as a service model."
  type        = string
  default     = null

  validation {
    condition     = var.memory_runtime_flush_model == null ? true : !contains([for model in [var.memory_runtime_embedding_model, var.memory_runtime_rerank_model] : lower(trimspace(model)) if model != null], lower(trimspace(var.memory_runtime_flush_model)))
    error_message = "memory_runtime_flush_model must differ from memory_runtime_embedding_model and memory_runtime_rerank_model, because the memory token issuer admits those without checking the environment's model policy."
  }
}

variable "memory_runtime_index_worker_maximum_concurrency" {
  description = "Maximum concurrent memory index worker invocations. Null keeps the memory-runtime module default."
  type        = number
  default     = null
}

variable "brain_runtime_answer_model" {
  description = "Model gateway route used for brain answers; the brain and agent-worker token issuers always admit it."
  type        = string
  default     = "openai/gpt-4o-mini"
}

variable "brain_runtime_upload_quotas" {
  description = "Optional Brain upload quota overrides; see brain-runtime upload_quotas. Null keeps every platform default."
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
}

variable "brain_runtime_index_worker_maximum_concurrency" {
  description = "Maximum concurrent Brain index worker invocations. Null keeps the brain-runtime module default."
  type        = number
  default     = null
}

variable "opensearch_instance_count" {
  description = "Instance count of each AWS-native OpenSearch domain (the shared search domain, or each of memory and brain; see operations.shared_search_domain)."
  type        = number
  default     = 2
}

variable "opensearch_instance_type" {
  description = "Instance type of each AWS-native OpenSearch domain (the shared search domain, or each of memory and brain; see operations.shared_search_domain)."
  type        = string
  default     = "m7g.large.search"
}

variable "opensearch_volume_size" {
  description = "EBS volume size in GiB of each AWS-native OpenSearch domain (the shared search domain, or each of memory and brain; see operations.shared_search_domain)."
  type        = number
  default     = 50
}

variable "agent_observability_history_enabled" {
  description = "Whether to deploy the Phase 2 observability cold-history pipeline."
  type        = bool
  default     = false
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

variable "agent_observability_destructive_cleanup_enabled" {
  description = "Whether observability cleanup may destructively remove history resources on teardown."
  type        = bool
  default     = false
}

variable "agent_observability_fact_stream_retention_hours" {
  description = "Retention of the observability fact stream in hours."
  type        = number
  default     = 72
}

variable "agent_observability_hot_enabled" {
  description = "Whether to deploy the Phase 3 ClickHouse hot plane."
  type        = bool
  default     = false
}

variable "agent_observability_hot_image" {
  description = "Immutable ARM64 observability hot-plane image."
  type        = string
  default     = ""
}

variable "agent_observability_clickhouse_ami_id" {
  description = "Optional ARM64 ClickHouse AMI. Empty pins Canonical's Ubuntu 24.04 ARM64 image at the first apply, and the node installs the checksum-pinned ClickHouse packages at boot."
  type        = string
  default     = ""
}

variable "agent_observability_clickhouse_instance_type" {
  description = "Graviton ClickHouse instance type: a t4g size from t4g.small or any r7g size. ClickHouse's memory cap follows it unless agent_observability_clickhouse_server_memory_bytes is set."
  type        = string
  default     = "t4g.medium"
}

variable "agent_observability_clickhouse_data_volume_size_gib" {
  description = "ClickHouse data volume size in GiB. It only grows; a smaller value keeps the current size."
  type        = number
  default     = 20
}

variable "agent_observability_clickhouse_root_volume_size_gib" {
  description = "ClickHouse host root volume size in GiB, at least the AMI's snapshot size."
  type        = number
  default     = 20
}

variable "agent_observability_clickhouse_server_memory_bytes" {
  description = "Optional ClickHouse server memory cap in bytes. Null caps ClickHouse at 70 percent of the instance's RAM."
  type        = number
  default     = null
}

variable "agent_observability_clickhouse_backup_retention_days" {
  description = "Days the hot plane keeps native ClickHouse backups and data-volume snapshots. Null keeps the lesser of operations.backup_retention_days and 7; observability history in Iceberg, not these backups, is what rebuilds the hot plane."
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
