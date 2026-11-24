variable "aws_region" {
  description = "AWS region exposed to local platform processes."
  type        = string
  default     = "us-east-1"
}

variable "aws_endpoint_url" {
  description = "Floci endpoint used for local AWS API emulation."
  type        = string
  default     = "http://127.0.0.1:4566"

  validation {
    condition     = can(regex("^https?://", var.aws_endpoint_url))
    error_message = "aws_endpoint_url must be an HTTP or HTTPS URL."
  }
}

variable "memory_model_gateway_base_url" {
  description = "Model gateway origin reachable from local memory worker Lambdas."
  type        = string
  default     = "http://host.docker.internal:8080"
}

variable "memory_model_gateway_token_issuer" {
  description = "Memory model token issuer function name reachable from local memory worker Lambdas; empty leaves the local memory runtime without a model gateway."
  type        = string
  default     = ""
}

variable "memory_jwt_audience" {
  description = "JWT audiences accepted by the local public memory API."
  type        = list(string)
  default     = ["deployments-ai-local"]
}

variable "memory_jwt_issuer" {
  description = "HTTPS JWT issuer used by the local public memory API."
  type        = string
  validation {
    condition     = can(regex("^https://[^/[:space:]]+", trimspace(var.memory_jwt_issuer)))
    error_message = "memory_jwt_issuer must be a non-empty HTTPS issuer URL."
  }
}

variable "memory_reconciliation_scopes" {
  description = "Local tenant scopes reconciled every five minutes. Override for locally created tenants."
  type = list(object({
    environment_id  = string
    organization_id = string
    project_id      = string
    workspace_id    = optional(string)
  }))
  default = [{
    environment_id  = "01ARZ3NDEKTSV4RRFFQ69G5FA2"
    organization_id = "01ARZ3NDEKTSV4RRFFQ69G5FA5"
    project_id      = "01ARZ3NDEKTSV4RRFFQ69G5FA6"
  }]
  validation {
    condition     = alltrue([for scope in var.memory_reconciliation_scopes : can(regex("^[0-7][0-9A-HJKMNP-TV-Z]{25}$", scope.environment_id)) && can(regex("^[0-7][0-9A-HJKMNP-TV-Z]{25}$", scope.organization_id)) && can(regex("^[0-7][0-9A-HJKMNP-TV-Z]{25}$", scope.project_id)) && try(scope.workspace_id == null ? true : can(regex("^[0-7][0-9A-HJKMNP-TV-Z]{25}$", scope.workspace_id)), true)])
    error_message = "memory_reconciliation_scopes must use canonical ULID identifiers."
  }
}
