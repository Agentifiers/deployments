variable "memory_runtime_enabled" {
  description = "Whether to create the public memory API and workers."
  type        = bool
  default     = true

  validation {
    condition = (
      !var.memory_runtime_enabled || var.enable_platform_events
    )
    error_message = "Memory runtime requires platform events."
  }
}

variable "memory_runtime_artifact_bucket" {
  description = "S3 bucket containing the production memory runtime Lambda artifact."
  type        = string
  default     = ""

  validation {
    condition     = !var.memory_runtime_enabled || try(trimspace(var.memory_runtime_artifact_bucket) != "", false)
    error_message = "memory_runtime_artifact_bucket is required when memory_runtime_enabled is true."
  }
}

variable "memory_runtime_artifact_key" {
  description = "S3 key containing the production memory runtime Lambda artifact."
  type        = string
  default     = ""

  validation {
    condition     = !var.memory_runtime_enabled || try(trimspace(var.memory_runtime_artifact_key) != "", false)
    error_message = "memory_runtime_artifact_key is required when memory_runtime_enabled is true."
  }
}

variable "memory_runtime_artifact_version" {
  description = "Immutable S3 object version for the production memory runtime Lambda artifact."
  type        = string
  default     = ""

  validation {
    condition = (
      !var.memory_runtime_enabled ||
      (
        trimspace(var.memory_runtime_artifact_version) != "" &&
        lower(trimspace(var.memory_runtime_artifact_version)) != "null"
      )
    )
    error_message = "A non-null memory_runtime_artifact_version is required when memory_runtime_enabled is true."
  }
}

variable "memory_runtime_membership_keyring" {
  description = "Optional complete OpenTofu-owned memory membership HMAC keyring; retain every historical version still referenced by durable records."
  type = object({
    current_version = number
    keys            = map(string)
  })
  default   = null
  nullable  = true
  sensitive = true

  validation {
    condition = var.memory_runtime_membership_keyring == null || try(
      var.memory_runtime_membership_keyring.current_version >= 1 &&
      floor(var.memory_runtime_membership_keyring.current_version) == var.memory_runtime_membership_keyring.current_version &&
      contains(keys(var.memory_runtime_membership_keyring.keys), tostring(var.memory_runtime_membership_keyring.current_version)) &&
      alltrue([
        for version, key in var.memory_runtime_membership_keyring.keys :
        can(regex("^[1-9][0-9]*$", version)) && tostring(tonumber(version)) == version && length(trimspace(key)) >= 32
      ]),
      false
    )
    error_message = "memory_runtime_membership_keyring must contain its positive integer current version and keys of at least 32 characters."
  }
}

variable "memory_runtime_reconciliation_scopes" {
  description = "Optional tenant environments that get a five-minute drift repair between canonical memory and the organization's search index. Memory and Brain search work without it; leave it empty unless you want scheduled repair for specific environments."
  type = list(object({
    environment_id  = string
    organization_id = string
    project_id      = string
    workspace_id    = optional(string)
  }))
  default = []
}
