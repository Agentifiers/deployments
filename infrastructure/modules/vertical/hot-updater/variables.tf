variable "account_id" {
  type        = string
  description = "Cloudflare account that owns the app-specific OTA resources."

  validation {
    condition     = trimspace(var.account_id) != ""
    error_message = "account_id must not be empty."
  }
}

variable "app_id" {
  type        = string
  description = "Stable vertical-owned mobile app identifier used in the deterministic resource suffix."

  validation {
    condition     = trimspace(var.app_id) != ""
    error_message = "app_id must not be empty."
  }
}

variable "app_slug" {
  type        = string
  description = "Human-readable app slug normalized for Cloudflare resource names."
}

variable "project_name" {
  type        = string
  description = "Shared project prefix used for Cloudflare resource names."
  default     = "deployments-ai"
}

variable "stage" {
  type        = string
  description = "Deployment stage isolated into its own D1 database, R2 bucket, Worker, and OpenTofu state."

  validation {
    condition     = contains(["dev", "prod"], var.stage)
    error_message = "stage must be dev or prod."
  }
}

variable "worker_bundle_path" {
  type        = string
  description = "Absolute path to the worker/dist/index.js bundle from the pinned @hot-updater/cloudflare package."

  validation {
    condition     = trimspace(var.worker_bundle_path) != ""
    error_message = "worker_bundle_path must not be empty."
  }
}

variable "workers_subdomain" {
  type        = string
  description = "Existing account-level workers.dev subdomain, created or resolved before composing this module."

  validation {
    condition     = trimspace(var.workers_subdomain) != ""
    error_message = "workers_subdomain must not be empty."
  }
}
