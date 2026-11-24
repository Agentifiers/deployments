variable "event_analytics_lifecycle" {
  description = "Event analytics lifecycle: absent, stopped, running, decommissioning, or destroyed."
  type        = string
  default     = "absent"

  validation {
    condition     = contains(["absent", "decommissioning", "destroyed", "running", "stopped"], var.event_analytics_lifecycle)
    error_message = "event_analytics_lifecycle must be absent, stopped, running, decommissioning, or destroyed."
  }
}

variable "event_analytics_extra_sources" {
  description = "EventBridge sources event analytics records in addition to deployments-ai.platform."
  type        = list(string)
  default     = []
}

variable "event_analytics_projector_artifact_bucket" {
  description = "S3 bucket containing the event analytics projector artifact."
  type        = string
  default     = null
}

variable "event_analytics_projector_artifact_key" {
  description = "S3 object key for the event analytics projector artifact."
  type        = string
  default     = null
}

variable "event_analytics_projector_artifact_version" {
  description = "Immutable S3 object version for the event analytics projector artifact."
  type        = string
  default     = null
}
