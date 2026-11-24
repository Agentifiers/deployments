variable "alarms_enabled" {
  description = "Whether the module creates its CloudWatch alarms. False creates none, for an installation whose ops alerts reach no one."
  type        = bool
  default     = true
}

variable "alarm_topic_arn" {
  description = "Ops alerts SNS topic ARN notified when an alarm enters or leaves the ALARM state."
  type        = string
}

variable "chromium_cpu" {
  description = "Fargate CPU units for each Chromium fallback renderer task. Null uses 512 with compact sizing and 1024 otherwise."
  type        = number
  default     = null

  validation {
    condition     = var.chromium_cpu == null || contains([256, 512, 1024, 2048, 4096], coalesce(var.chromium_cpu, 0))
    error_message = "chromium_cpu must be null or one of 256, 512, 1024, 2048, or 4096."
  }
}

variable "chromium_desired_count" {
  description = "Chromium fallback renderer task count. Every Firecrawl task shares these tasks through Cloud Map; zero leaves Firecrawl on Lightpanda and plain fetch only."
  type        = number
  default     = 0

  validation {
    condition     = var.chromium_desired_count >= 0 && floor(var.chromium_desired_count) == var.chromium_desired_count
    error_message = "chromium_desired_count must be a non-negative integer."
  }
}

variable "chromium_max_concurrent_pages" {
  description = "Concurrent pages each Chromium fallback renderer task serves. Null uses 1 with compact sizing and 2 otherwise."
  type        = number
  default     = null

  validation {
    condition = var.chromium_max_concurrent_pages == null || (
      coalesce(var.chromium_max_concurrent_pages, 0) >= 1 &&
      floor(coalesce(var.chromium_max_concurrent_pages, 0)) == var.chromium_max_concurrent_pages
    )
    error_message = "chromium_max_concurrent_pages must be null or a positive integer."
  }
}

variable "chromium_memory" {
  description = "Fargate memory MiB for each Chromium fallback renderer task; must be valid for the task CPU. Null uses 2048 with compact sizing and 4096 otherwise."
  type        = number
  default     = null

  validation {
    condition = var.chromium_memory == null || (
      floor(coalesce(var.chromium_memory, 0)) == var.chromium_memory &&
      (coalesce(var.chromium_memory, 0) == 512 || coalesce(var.chromium_memory, 0) % 1024 == 0)
    )
    error_message = "chromium_memory must be null, 512, or a whole number of GiB in MiB."
  }
}

variable "compact_task_sizing_enabled" {
  description = "Whether the Firecrawl task and its containers use the compact 0.5 vCPU / 3 GiB size instead of 2 vCPU / 4 GiB; also selects the default Chromium fallback task size."
  type        = bool
}

variable "ecs_cluster_arn" {
  description = "Existing private runtime ECS cluster ARN. It must register the FARGATE and FARGATE_SPOT capacity providers."
  type        = string

  validation {
    condition     = can(regex("^arn:[^:]+:ecs:[^:]+:[0-9]{12}:cluster/.+$", var.ecs_cluster_arn))
    error_message = "ecs_cluster_arn must be an ECS cluster ARN."
  }
}

variable "fargate_spot_enabled" {
  description = "Whether the Firecrawl task runs on FARGATE_SPOT instead of FARGATE capacity."
  type        = bool
}

variable "deletion_protection_enabled" {
  description = "Whether the Firecrawl DynamoDB table has deletion protection."
  type        = bool
}

variable "desired_count" {
  description = "Firecrawl task count. Tasks share the DynamoDB queue and state, so any count works."
  type        = number
  default     = 0

  validation {
    condition     = var.desired_count >= 0 && floor(var.desired_count) == var.desired_count
    error_message = "desired_count must be a non-negative integer."
  }
}

variable "domain_name" {
  description = "Private HTTPS hostname for Firecrawl."
  type        = string

  validation {
    condition = can(regex(
      "^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$",
      var.domain_name,
    ))
    error_message = "domain_name must be a lowercase DNS hostname."
  }
}

variable "environment" {
  description = "Platform environment name."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must start with a lowercase letter and contain at most 16 lowercase letters, digits, or hyphens."
  }
}

variable "lightpanda_image" {
  description = "Immutable unmodified Lightpanda browser image serving CDP to Firecrawl inside its task."
  type        = string
  default     = "lightpanda/browser@sha256:5b84708cb3d9bef841aba4a4cd299f4de0609ac1bd7d4c6fbfcbf168d56b685e"

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.lightpanda_image))
    error_message = "lightpanda_image must be pinned by sha256 digest."
  }
}

variable "log_retention_in_days" {
  description = "CloudWatch log retention for the Firecrawl runtime log group."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a CloudWatch Logs retention value."
  }
}

variable "load_balancer_arn" {
  description = "Existing private runtime application load balancer ARN."
  type        = string
}

variable "load_balancer_dns_name" {
  description = "Existing private runtime application load balancer DNS name."
  type        = string
}

variable "load_balancer_zone_id" {
  description = "Existing private runtime application load balancer Route 53 zone ID."
  type        = string
}

variable "load_balancer_security_group_id" {
  description = "Security group attached to the existing private runtime load balancer."
  type        = string
}

variable "model_gateway_base_url" {
  description = "Fixed private OpenAI-compatible model gateway base URL, including its version path."
  type        = string

  validation {
    condition     = can(regex("^https?://[A-Za-z0-9.-]+(:[0-9]+)?(/[^?#]*)?$", var.model_gateway_base_url))
    error_message = "model_gateway_base_url must be an HTTP or HTTPS URL without credentials, query, or fragment."
  }
}

variable "model_gateway_token_issuer" {
  description = "Web Tools model token issuer Lambda (arn, function_name); the proxy sidecar mints gateway tokens with it."
  type = object({
    arn           = string
    function_name = string
  })
}

variable "firecrawl_image" {
  description = "Immutable release image of the Firecrawl fork (infrastructure/images/firecrawl)."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.firecrawl_image))
    error_message = "firecrawl_image must be pinned by sha256 digest."
  }
}

variable "firecrawl_table" {
  description = "DynamoDB table definition (format version 1) that firecrawl_image ships at /app/dynamodb-table.json; the release build exports it from that image and the deploy tool passes it unchanged."
  type = object({
    version      = number
    billing_mode = string
    hash_key     = string
    range_key    = optional(string)
    attributes = list(object({
      name = string
      type = string
    }))
    ttl_attribute = string
    global_secondary_indexes = list(object({
      name               = string
      hash_key           = string
      range_key          = optional(string)
      projection_type    = string
      non_key_attributes = optional(list(string))
    }))
  })
  nullable = false

  validation {
    condition     = var.firecrawl_table.version == 1 && var.firecrawl_table.billing_mode == "PAY_PER_REQUEST"
    error_message = "firecrawl_table must be table definition version 1 with PAY_PER_REQUEST billing."
  }

  validation {
    condition = alltrue([
      for attribute in var.firecrawl_table.attributes : contains(["S", "N", "B"], attribute.type)
    ])
    error_message = "firecrawl_table attribute types must be S, N, or B."
  }

  validation {
    condition = alltrue([
      for index in var.firecrawl_table.global_secondary_indexes :
      contains(["ALL", "KEYS_ONLY", "INCLUDE"], index.projection_type) &&
      (index.projection_type == "INCLUDE") == length(coalesce(index.non_key_attributes, [])) > 0
    ])
    error_message = "firecrawl_table index projections must be ALL, KEYS_ONLY, or INCLUDE, and only INCLUDE lists non_key_attributes."
  }

  validation {
    condition = (
      length(distinct(var.firecrawl_table.attributes[*].name)) == length(var.firecrawl_table.attributes) &&
      sort(var.firecrawl_table.attributes[*].name) == sort(distinct(compact(flatten([
        [var.firecrawl_table.hash_key, var.firecrawl_table.range_key],
        [for index in var.firecrawl_table.global_secondary_indexes : [index.hash_key, index.range_key]],
      ]))))
    )
    error_message = "firecrawl_table attributes must declare each table and index key exactly once."
  }
}

variable "firecrawl_embedding_model_name" {
  description = "OpenAI-compatible embedding model routed through the fixed model-gateway proxy; the web-tools token issuer must list it."
  type        = string

  validation {
    condition     = trimspace(var.firecrawl_embedding_model_name) != ""
    error_message = "firecrawl_embedding_model_name must not be empty."
  }
}

variable "firecrawl_model_name" {
  description = "OpenAI-compatible chat model routed through the fixed model-gateway proxy; the web-tools token issuer must list it."
  type        = string

  validation {
    condition     = trimspace(var.firecrawl_model_name) != ""
    error_message = "firecrawl_model_name must not be empty."
  }
}

variable "playwright_image" {
  description = "Immutable unmodified Firecrawl Playwright service image run by the Chromium fallback renderer service."
  type        = string
  default     = "ghcr.io/firecrawl/playwright-service@sha256:c2cb9d7e982f9ddaf7902ec79da1e63961ae3760f315cddaa161200a7937162b"

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.playwright_image))
    error_message = "playwright_image must be pinned by sha256 digest."
  }
}

variable "point_in_time_recovery_enabled" {
  description = "Whether the Firecrawl DynamoDB table has point-in-time recovery."
  type        = bool
}

variable "private_subnet_ids" {
  description = "Private platform subnet IDs for the Firecrawl and Chromium tasks."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) >= 2
    error_message = "At least two private subnets are required for the internal load balancer."
  }
}

variable "reserved_ipv4_egress_filtered" {
  description = "Confirms that the private-subnet egress hop rejects canonical private and reserved IPv4 ranges."
  type        = bool

  validation {
    condition     = var.reserved_ipv4_egress_filtered
    error_message = "Web Tools requires a private-subnet egress hop that rejects private and reserved IPv4 ranges."
  }
}

variable "proxy_image" {
  description = "Immutable image built from packages/web-tools-proxy/Dockerfile for deny-private web and model egress proxies."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.proxy_image))
    error_message = "proxy_image must be pinned by sha256 digest."
  }
}

variable "route53_zone_id" {
  description = "Route 53 zone containing domain_name."
  type        = string

  validation {
    condition     = can(regex("^Z[A-Z0-9]+$", var.route53_zone_id))
    error_message = "route53_zone_id must be a Route 53 hosted zone ID."
  }
}

variable "searxng_image" {
  description = "Immutable unmodified SearXNG image."
  type        = string
  default     = "searxng/searxng@sha256:b8ca38ba06eea544d7555e88321e212ddc0d5c3c7de055419cfb2e5c6bf30812"

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.searxng_image))
    error_message = "searxng_image must be pinned by sha256 digest."
  }
}

variable "secret_recovery_window_in_days" {
  description = "Secrets Manager recovery window."
  type        = number
  default     = 0
}

variable "tags" {
  description = "Additional resource tags."
  type        = map(string)
  default     = {}
}

variable "vpc_id" {
  description = "Shared platform VPC ID."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}
