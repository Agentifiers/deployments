variable "agent_runtime_enabled" {
  description = "Whether to deploy the queue-backed hosted agent runtime."
  type        = bool
  default     = false
}

variable "agent_runtime_artifact_bucket" {
  description = "S3 bucket containing the hosted agent runtime Lambda artifact."
  type        = string
  default     = ""
}

variable "agent_runtime_artifact_key" {
  description = "S3 key containing the hosted agent runtime Lambda artifact."
  type        = string
  default     = ""
}

variable "agent_runtime_artifact_version" {
  description = "Immutable S3 object version for the hosted agent runtime Lambda artifact."
  type        = string
  default     = ""
}

variable "agent_runtime_browser_allowed_origins" {
  description = "HTTPS origins that hosted agents may target with sandbox browser tools."
  type        = set(string)
  default     = []
}

variable "agent_runtime_browser_any_public_origin" {
  description = "Let hosted agents open any public origin with sandbox browser tools instead of only agent_runtime_browser_allowed_origins."
  type        = bool
  default     = false
}

variable "agent_runtime_firecrawl_api_key_secret_arn" {
  description = "Optional Secrets Manager ARN containing an external self-hosted Firecrawl API key."
  type        = string
  default     = null
}

variable "agent_runtime_firecrawl_base_url" {
  description = "HTTPS base URL of an external self-hosted Firecrawl service, used when web_tools_runtime_enabled is false."
  type        = string
  default     = null
}

variable "agent_runtime_firecrawl_job_ticket_secret_arn" {
  description = "Secrets Manager ARN for scoped external Firecrawl job tickets, used when web_tools_runtime_enabled is false."
  type        = string
  default     = null
}

variable "agent_runtime_web_tools_enabled" {
  description = "Whether hosted agents may advertise and execute self-hosted Firecrawl tools."
  type        = bool
  default     = false
}

variable "agent_runtime_legacy_webhook_signing_secret_arns" {
  description = "Secrets Manager ARNs used by legacy webhook endpoint records during migration."
  type        = list(string)
  default     = []
}

variable "agent_worker_image" {
  description = "Digest-pinned ARM64 agent worker image built from functions/worker/Dockerfile."
  type        = string
  default     = ""
}

variable "agent_runtime_api_reserved_concurrency" {
  description = "Reserved Lambda concurrency for the agent runtime API, or -1 for unreserved concurrency."
  type        = number
  default     = 20
}

variable "agent_runtime_webhook_events_reserved_concurrency" {
  description = "Reserved Lambda concurrency for webhook event delivery, or -1 for unreserved concurrency."
  type        = number
  default     = 10
}

variable "alerts" {
  description = "Customer monitors and alert email. Alert email is sent from email_sender, which defaults to platform_identity_email_sender and must be on an SES identity the install verified; product_name heads every email. A self-hosted install sets both to its own."
  type = object({
    enabled      = optional(bool, true)
    email_sender = optional(string, "")
    product_name = optional(string, "Deployments.ai")
  })
  default  = {}
  nullable = false
}

variable "model_runtime_enabled" {
  description = "Whether to create the model runtime (model gateway and Bifrost) and its shared internal load balancer."
  type        = bool
  default     = true
}

variable "model_runtime_hosted_providers" {
  description = "Hosted model providers enabled in the Bifrost runtime: bedrock, openai, openrouter. Bedrock uses the model runtime task role in the deployment region and needs no API key."
  type        = set(string)
  default     = ["openai", "openrouter"]
}

variable "model_runtime_openai_tailnet_upstream" {
  description = "Tailnet OpenAI-compatible endpoint (Tailscale IPv4 address and TCP port) that serves the openai provider through a private relay instance, and the bare model ids it serves (without the openai/ prefix), which the model catalog lists in place of api.openai.com/v1/models. Null uses api.openai.com."
  type = object({
    address   = string
    model_ids = list(string)
    port      = number
  })
  default = null

  validation {
    condition = var.model_runtime_openai_tailnet_upstream == null || try(
      can(regex("^100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])(\\.(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])){2}$", var.model_runtime_openai_tailnet_upstream.address)) &&
      floor(var.model_runtime_openai_tailnet_upstream.port) == var.model_runtime_openai_tailnet_upstream.port &&
      var.model_runtime_openai_tailnet_upstream.port >= 1024 &&
      var.model_runtime_openai_tailnet_upstream.port <= 65535,
      false
    )
    error_message = "model_runtime_openai_tailnet_upstream must name a Tailscale IPv4 address in 100.64.0.0/10 and a TCP port from 1024 to 65535; the relay forwards it without root."
  }

  validation {
    condition     = var.model_runtime_openai_tailnet_upstream == null || contains(var.model_runtime_hosted_providers, "openai")
    error_message = "model_runtime_openai_tailnet_upstream requires openai in model_runtime_hosted_providers."
  }

  validation {
    condition = var.model_runtime_openai_tailnet_upstream == null || try(
      length(var.model_runtime_openai_tailnet_upstream.model_ids) > 0 &&
      alltrue([for id in var.model_runtime_openai_tailnet_upstream.model_ids : can(regex("^[A-Za-z0-9][A-Za-z0-9._:-]*$", id))]),
      false
    )
    error_message = "model_runtime_openai_tailnet_upstream.model_ids must list at least one bare model id such as gpt-6-luna, without a provider prefix."
  }
}

variable "bifrost_desired_count" {
  description = "Model gateway task count. Keep zero until runtime parameters are populated."
  type        = number
  default     = 0
}

variable "bifrost_image" {
  description = "Digest-pinned ARM64 Bifrost image built from infrastructure/images/bifrost/Dockerfile."
  type        = string
  default     = ""
}

variable "model_gateway_image" {
  description = "Digest-pinned ARM64 image built from apps/model-gateway/Dockerfile."
  type        = string
  default     = ""
}

variable "model_gateway_previous_signing_key_arns" {
  description = "Retired model gateway token signing KMS key ARNs the gateway still trusts during a key rotation."
  type        = list(string)
  default     = []
}

variable "model_gateway_service_fallback_model_ids" {
  description = "Fallback model ids service chat calls without explicit fallbacks request (passed to the agent worker, evaluation worker, platform API, memory runtime, and Brain index worker as DEPLOYMENTS_AI_DEFAULT_MODEL_FALLBACK_IDS) and the agent-worker, evaluations, memory, and brain token issuers admit. The default equals the gateway client's built-in DEFAULT_AGENT_MODEL_FALLBACK_IDS."
  type        = list(string)
  default     = ["openrouter/z-ai/glm-5.2", "openrouter/xiaomi/mimo-v2.5"]
}

variable "durable_streams_enabled" {
  description = "Whether to create the private Durable Streams runtime."
  type        = bool
  default     = true
}

variable "durable_streams_desired_count" {
  description = "Durable Streams task count."
  type        = number
  default     = 0
}

variable "durable_streams_deletion_protection_enabled" {
  description = "Whether the Durable Streams load balancer has deletion protection enabled."
  type        = bool
  default     = true
}

variable "durable_streams_image" {
  description = "Digest-pinned image built from apps/durable-streams/Dockerfile."
  type        = string
  default     = ""
}

variable "stream_gateway_deletion_protection_enabled" {
  description = "Whether the public stream gateway load balancer has deletion protection enabled. Disable this in a separate apply before removing the gateway."
  type        = bool
  default     = true
}

variable "stream_gateway_domain_name" {
  description = "Public hostname for the stream gateway, in the platform API Route 53 zone."
  type        = string
  default     = ""
}

variable "stream_gateway_image" {
  description = "Digest-pinned image built from apps/stream-gateway/Dockerfile."
  type        = string
  default     = ""
}

variable "sandbox_lambda_microvm_enabled" {
  description = "Whether to create Lambda MicroVM image build and worker IAM prerequisites."
  type        = bool
  default     = false
}

variable "sandbox_usage_cost_policy" {
  description = "Optional hourly USD-micro rates that price Lambda MicroVM sandbox time as operator-funded spend: a base rate per sandbox, a rate per reserved vCPU, and a rate per reserved GiB of memory. Null leaves sandbox usage unpriced."
  type = object({
    base_hour_usd_micros       = optional(number)
    memory_gib_hour_usd_micros = optional(number)
    vcpu_hour_usd_micros       = optional(number)
  })
  default = null

  validation {
    condition = var.sandbox_usage_cost_policy == null || alltrue([
      for rate in values(var.sandbox_usage_cost_policy) : rate == null || (rate >= 0 && rate <= 1000000000 && floor(rate) == rate)
    ])
    error_message = "sandbox_usage_cost_policy rates must be whole numbers of USD micros from 0 to 1000000000."
  }
}

variable "lambda_microvm_execution_role_arn" {
  description = "Optional IAM execution role passed to each Lambda MicroVM."
  type        = string
  default     = ""
}

variable "lambda_microvm_image_identifier" {
  description = "Published content-addressed Lambda MicroVM image ARN."
  type        = string
  default     = ""
}

variable "lambda_microvm_image_capacity" {
  description = "Memory and vCPU of the published Lambda MicroVM image, which the worker reserves and meters. Null uses the worker's 2048 MiB and 1 vCPU default."
  type = object({
    memory_mib = number
    vcpu       = number
  })
  default = null
}

variable "lambda_microvm_image_version" {
  description = "Active version of the published content-addressed Lambda MicroVM image."
  type        = string
  default     = ""
}

variable "web_tools_runtime_enabled" {
  description = "Whether to create the private self-hosted Firecrawl runtime for hosted agents."
  type        = bool
  default     = false
}

variable "web_tools_chromium_cpu" {
  description = "Fargate CPU units per Chromium fallback renderer task; null derives it from compact sizing."
  type        = number
  default     = null
}

variable "web_tools_chromium_desired_count" {
  description = "Chromium fallback renderer task count shared by every Firecrawl task."
  type        = number
  default     = 0
}

variable "web_tools_chromium_max_concurrent_pages" {
  description = "Concurrent pages per Chromium fallback renderer task; null derives it from compact sizing."
  type        = number
  default     = null
}

variable "web_tools_chromium_memory" {
  description = "Fargate memory MiB per Chromium fallback renderer task; null derives it from compact sizing."
  type        = number
  default     = null
}

variable "web_tools_desired_count" {
  description = "Firecrawl task count."
  type        = number
  default     = 0
}

variable "web_tools_domain_name" {
  description = "Private Firecrawl hostname."
  type        = string
  default     = ""
}

variable "web_tools_firecrawl_embedding_model_name" {
  description = "Embedding model Firecrawl calls through the model gateway; the web-tools token issuer always admits it."
  type        = string
  default     = "openrouter/openai/text-embedding-3-small"
}

variable "web_tools_firecrawl_image" {
  description = "Digest-pinned ARM64 release image of the Firecrawl fork (infrastructure/images/firecrawl)."
  type        = string
  default     = ""
}

variable "web_tools_firecrawl_table" {
  description = "DynamoDB table definition web_tools_firecrawl_image ships at /app/dynamodb-table.json; the deploy tool writes it from the release bundle. modules/web-tools-runtime types and validates it."
  type        = any
  default     = null
}

variable "web_tools_firecrawl_model_name" {
  description = "Chat model Firecrawl calls through the model gateway; the web-tools token issuer always admits it."
  type        = string
  default     = "openrouter/openai/gpt-4o"
}

variable "web_tools_proxy_image" {
  description = "Digest-pinned ARM64 image built from packages/web-tools-proxy/Dockerfile for deny-private Firecrawl egress."
  type        = string
  default     = ""
}

variable "web_tools_route53_zone_id" {
  description = "Route 53 hosted zone that publishes web_tools_domain_name."
  type        = string
  default     = ""
}
