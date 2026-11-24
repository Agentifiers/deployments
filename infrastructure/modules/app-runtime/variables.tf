variable "alarms_enabled" {
  description = "Whether the module creates its CloudWatch alarms. False creates none, for an installation whose ops alerts reach no one."
  type        = bool
  default     = true
}

variable "alarm_topic_arn" {
  description = "Ops alerts SNS topic ARN notified when a reconciler alarm enters or leaves the ALARM state."
  type        = string
}

variable "compact_task_sizing_enabled" {
  description = "Whether the gateway task uses the smallest Fargate size."
  type        = bool
}

variable "container_insights_enabled" {
  description = "Whether the apps ECS cluster has Container Insights."
  type        = bool
}

variable "control_table" {
  description = "Platform control table, which holds app, release, and grant records."
  type = object({
    arn  = string
    name = string
  })
}

variable "database_function_artifact" {
  description = "Initial S3 location of the apps-database Lambda bundle; the deploy pipeline updates the code afterwards."
  type = object({
    bucket  = string
    key     = string
    version = string
  })
}

variable "deletion_protection_enabled" {
  description = "Whether the apps cluster has deletion protection and takes a final snapshot when destroyed, and the apps bucket refuses to be destroyed with objects."
  type        = bool
}

variable "domain" {
  description = "Apps domain. Its apex serves the sign-in callback and each <slug>.<domain> host serves one app."
  type        = string
}

variable "domain_certificate_requests_per_day" {
  description = "TLS certificate requests the apps-domains Lambda may make per UTC day for every organization together. 12 a day is 4,380 a year, under ACM's default 5,000 certificates per account per 365 days; raise that ACM quota before raising this."
  type        = number
  default     = 12

  validation {
    condition     = var.domain_certificate_requests_per_day >= 1 && floor(var.domain_certificate_requests_per_day) == var.domain_certificate_requests_per_day
    error_message = "domain_certificate_requests_per_day must be a whole number of at least 1."
  }
}

variable "domain_certificate_requests_per_organization_per_day" {
  description = "TLS certificate requests the apps-domains Lambda may make per UTC day for one organization's app domains."
  type        = number
  default     = 5

  validation {
    condition     = var.domain_certificate_requests_per_organization_per_day >= 1 && floor(var.domain_certificate_requests_per_organization_per_day) == var.domain_certificate_requests_per_organization_per_day
    error_message = "domain_certificate_requests_per_organization_per_day must be a whole number of at least 1."
  }
}

variable "domain_reconciler_artifact" {
  description = "Initial S3 location of the apps-domains Lambda bundle; the deploy pipeline updates the code afterwards."
  type = object({
    bucket  = string
    key     = string
    version = string
  })
}

variable "environment" {
  description = "Platform environment name."
  type        = string
}

variable "events_table" {
  description = "Platform events table, which receives app domain semantic events."
  type = object({
    arn  = string
    name = string
  })
}

variable "fargate_spot_enabled" {
  description = "Whether the gateway runs on Fargate Spot."
  type        = bool
}

variable "gateway_image" {
  description = "Digest-pinned image built from apps/app-gateway/Dockerfile."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.gateway_image))
    error_message = "gateway_image must be pinned by sha256 digest."
  }
}

variable "high_availability_enabled" {
  description = "Whether the gateway runs two tasks."
  type        = bool
}

variable "identity_issuer" {
  description = "Platform OIDC issuer URL the gateway signs members in with."
  type        = string
}

variable "identity_table" {
  description = "Platform identity table, which holds app sessions."
  type = object({
    arn  = string
    name = string
  })
}

variable "internal_load_balancer" {
  description = "Shared internal ALB that carries the gateway listener behind the CloudFront VPC origin."
  type = object({
    arn               = string
    dns_name          = string
    security_group_id = string
  })
}

variable "log_retention_in_days" {
  description = "CloudWatch log retention for the gateway and the apps-database and apps-domains Lambdas."
  type        = number
}

variable "max_capacity" {
  description = "Maximum Aurora Serverless v2 capacity of the apps cluster, in ACUs."
  type        = number
  default     = 4
}

variable "min_capacity" {
  description = "Minimum Aurora Serverless v2 capacity of the apps cluster, in ACUs. Zero lets the cluster pause when idle."
  type        = number
  default     = 0
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}

variable "private_subnet_ids" {
  description = "Private platform subnet IDs for the apps cluster, the gateway, and the apps-database Lambda."
  type        = list(string)
}

variable "route53_zone_id" {
  description = "Route 53 zone that holds the apps domain."
  type        = string
}

variable "seconds_until_auto_pause" {
  description = "Seconds without connections before a zero-minimum apps cluster pauses."
  type        = number
  default     = 300
}

variable "tags" {
  description = "Additional resource tags."
  type        = map(string)
  default     = {}
}

variable "usage_table" {
  description = "Platform usage table, which holds the daily certificate request counters of the apps-domains Lambda."
  type = object({
    arn  = string
    name = string
  })
}

variable "vpc_id" {
  description = "Shared platform VPC ID."
  type        = string
}
