variable "web_tools_runtime_enabled" {
  description = "Whether to run the private self-hosted Firecrawl, its egress proxy, and a Chromium fallback renderer for hosted agents' web tools. It needs network_nat_mode instance, whose NAT instance rejects forwarding to private and reserved IPv4 ranges."
  type        = bool
  default     = true

  validation {
    condition     = !var.web_tools_runtime_enabled || (var.agent_runtime_enabled && var.network_nat_mode != "gateway")
    error_message = "web_tools_runtime_enabled requires agent_runtime_enabled and a network_nat_mode of instance or null."
  }
}

variable "web_tools_desired_count" {
  description = "Firecrawl task count."
  type        = number
  default     = 1
}

variable "web_tools_chromium_desired_count" {
  description = "Chromium fallback renderer task count, shared by every Firecrawl task."
  type        = number
  default     = 1
}

variable "web_tools_domain_name" {
  description = "Hostname of the private Firecrawl endpoint. Null uses web-tools.<platform_api_domain_name>. It resolves to the shared internal load balancer, so only the VPC can reach it."
  type        = string
  default     = null
}

variable "web_tools_route53_zone_id" {
  description = "Route 53 hosted zone that publishes web_tools_domain_name and validates its certificate. Empty uses platform_api_route53_zone_id."
  type        = string
  default     = ""
  nullable    = false
}

variable "web_tools_firecrawl_image" {
  description = "Digest-pinned ARM64 Firecrawl image; set by the deploy tool."
  type        = string
  default     = ""

  validation {
    condition     = !var.web_tools_runtime_enabled || can(regex("@sha256:[0-9a-f]{64}$", var.web_tools_firecrawl_image))
    error_message = "Set web_tools_firecrawl_image to a sha256-pinned image when web_tools_runtime_enabled is true."
  }
}

variable "web_tools_firecrawl_table" {
  description = "DynamoDB table definition the Firecrawl image ships; set by the deploy tool from the release bundle."
  type        = any
  default     = null
}

variable "web_tools_proxy_image" {
  description = "Digest-pinned ARM64 web-tools-proxy image for deny-private Firecrawl egress; set by the deploy tool."
  type        = string
  default     = ""

  validation {
    condition     = !var.web_tools_runtime_enabled || can(regex("@sha256:[0-9a-f]{64}$", var.web_tools_proxy_image))
    error_message = "Set web_tools_proxy_image to a sha256-pinned image when web_tools_runtime_enabled is true."
  }
}
