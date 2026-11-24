variable "memory_runtime_embedding_model" {
  description = "Model gateway route for memory and Brain embeddings. It must return 1,536-dimension vectors, the dimension the memory search indexes use."
  type        = string
  default     = "bedrock/global.cohere.embed-v4:0"
  nullable    = false

  validation {
    condition     = contains(var.model_runtime_hosted_providers, split("/", var.memory_runtime_embedding_model)[0])
    error_message = "memory_runtime_embedding_model must start with a provider prefix listed in model_runtime_hosted_providers."
  }
}

variable "memory_runtime_rerank_model" {
  description = "Chat model the memory runtime reranks recall candidates with."
  type        = string
  default     = "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0"
  nullable    = false

  validation {
    condition     = contains(var.model_runtime_hosted_providers, split("/", var.memory_runtime_rerank_model)[0])
    error_message = "memory_runtime_rerank_model must start with a provider prefix listed in model_runtime_hosted_providers."
  }
}

variable "memory_runtime_flush_model" {
  description = "Chat model memory flushes use in place of the run's agent model when the run's environment admits it; null keeps the agent's model."
  type        = string
  default     = null

  validation {
    condition     = var.memory_runtime_flush_model == null ? true : contains(var.model_runtime_hosted_providers, split("/", var.memory_runtime_flush_model)[0])
    error_message = "memory_runtime_flush_model must be null or start with a provider prefix listed in model_runtime_hosted_providers."
  }

  validation {
    condition     = var.memory_runtime_flush_model == null ? true : !contains([for model in [var.memory_runtime_embedding_model, var.memory_runtime_rerank_model] : lower(trimspace(model)) if model != null], lower(trimspace(var.memory_runtime_flush_model)))
    error_message = "memory_runtime_flush_model must differ from memory_runtime_embedding_model and memory_runtime_rerank_model, because the memory token issuer admits those without checking the environment's model policy."
  }
}

variable "brain_runtime_answer_model" {
  description = "Chat model that writes Brain answers."
  type        = string
  default     = "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0"
  nullable    = false

  validation {
    condition     = contains(var.model_runtime_hosted_providers, split("/", var.brain_runtime_answer_model)[0])
    error_message = "brain_runtime_answer_model must start with a provider prefix listed in model_runtime_hosted_providers."
  }
}

variable "model_gateway_service_fallback_model_ids" {
  description = "Fallback models service chat calls request when they name none. The agent-worker, evaluations, memory, and brain token issuers admit them."
  type        = list(string)
  default     = ["bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0"]
  nullable    = false

  validation {
    condition = length(var.model_gateway_service_fallback_model_ids) > 0 && alltrue([
      for model in var.model_gateway_service_fallback_model_ids :
      contains(var.model_runtime_hosted_providers, split("/", model)[0])
    ])
    error_message = "model_gateway_service_fallback_model_ids must list at least one model, each starting with a provider prefix listed in model_runtime_hosted_providers."
  }
}

variable "web_tools_firecrawl_model_name" {
  description = "Chat model the in-stack Firecrawl calls through the model gateway."
  type        = string
  default     = "bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0"
  nullable    = false

  validation {
    condition     = contains(var.model_runtime_hosted_providers, split("/", var.web_tools_firecrawl_model_name)[0])
    error_message = "web_tools_firecrawl_model_name must start with a provider prefix listed in model_runtime_hosted_providers."
  }
}

variable "web_tools_firecrawl_embedding_model_name" {
  description = "Embedding model the in-stack Firecrawl calls through the model gateway."
  type        = string
  default     = "bedrock/global.cohere.embed-v4:0"
  nullable    = false

  validation {
    condition     = contains(var.model_runtime_hosted_providers, split("/", var.web_tools_firecrawl_embedding_model_name)[0])
    error_message = "web_tools_firecrawl_embedding_model_name must start with a provider prefix listed in model_runtime_hosted_providers."
  }
}
