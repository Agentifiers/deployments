variable "name" { type = string }
variable "permissions_boundary_arn" {
  type    = string
  default = ""
}
variable "cluster_arn" { type = string }
variable "vpc_id" { type = string }
variable "subnet_ids" { type = list(string) }
variable "service_discovery_namespace_id" { type = string }
variable "image" { type = string }
variable "cpu" { type = number }
variable "memory" { type = number }

variable "architecture" {
  type    = string
  default = "ARM64"
}

variable "command" {
  type    = list(string)
  default = []
}

variable "entrypoint" {
  type    = list(string)
  default = []
}

variable "environment" {
  type    = map(string)
  default = {}
}

variable "secrets" {
  description = "Environment variable name to SecureString parameter ARN that ECS injects at task start."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for arn in values(var.secrets) : can(regex("^arn:[^:]+:ssm:[^:]+:[0-9]{12}:parameter/.+$", arn))])
    error_message = "secrets values must be SSM parameter ARNs."
  }
}

variable "init_containers" {
  description = "Non-essential containers that must complete successfully before the application container starts."
  type = list(object({
    name        = string
    image       = string
    command     = list(string)
    entrypoint  = optional(list(string), [])
    environment = optional(map(string), {})
    secrets     = optional(map(string), {})
    cpu         = optional(number, 0)
    memory      = optional(number, null)
    depends_on = optional(list(object({
      container_name = string
      condition      = string
    })), [])
  }))
  default = []

  validation {
    condition = alltrue(flatten([
      for container in var.init_containers : [
        for arn in values(container.secrets) : can(regex("^arn:[^:]+:ssm:[^:]+:[0-9]{12}:parameter/.+$", arn))
      ]
    ]))
    error_message = "init_containers secrets values must be SSM parameter ARNs."
  }
}

variable "container_port" {
  type    = number
  default = null
}

variable "health_check_command" {
  type    = list(string)
  default = []
}

variable "desired_count" {
  type    = number
  default = 1
}

variable "retain_task_definition_revisions" {
  description = "Retain replaced task definitions for administrator cleanup instead of requiring account-wide ECS deregistration permission."
  type        = bool
  default     = false
}

variable "deployment_maximum_percent" {
  description = "Upper bound on running and pending tasks during an ECS deployment."
  type        = number
  default     = 200

  validation {
    condition     = var.deployment_maximum_percent > 100 && var.deployment_maximum_percent <= 200
    error_message = "deployment_maximum_percent must be greater than 100 and no greater than 200."
  }
}

variable "deployment_minimum_healthy_percent" {
  description = "Lower bound on healthy tasks during an ECS deployment."
  type        = number
  default     = 100

  validation {
    condition     = var.deployment_minimum_healthy_percent >= 0 && var.deployment_minimum_healthy_percent <= 100
    error_message = "deployment_minimum_healthy_percent must be between 0 and 100."
  }
}

variable "wait_for_steady_state" {
  description = "Wait for the ECS deployment to reach a steady state before completing dependent graph nodes."
  type        = bool
  default     = false
}

variable "assign_public_ip" {
  type    = bool
  default = false
}

variable "additional_security_group_ids" {
  description = "Additional security groups attached to every task, such as a shared Valkey client group."
  type        = list(string)
  default     = []
}

variable "alb_listener_arn" {
  type    = string
  default = ""
}

variable "alb_security_group_id" {
  type    = string
  default = ""
}

variable "route_prefix" {
  type    = string
  default = ""
}

variable "route_priority" {
  type    = number
  default = 100
}

variable "rewrite_route_prefix" {
  type    = bool
  default = true
}

variable "health_check_path" {
  type    = string
  default = "/"
}

variable "health_check_codes" {
  type    = string
  default = "200-399"
}

variable "efs_volume" {
  type = object({
    file_system_id   = string
    access_point_arn = string
    container_path   = string
  })
  default = null
}

variable "task_policy_json" {
  type    = string
  default = ""
}

variable "create_task_policy" {
  type    = bool
  default = false
}

variable "tags" {
  type    = map(string)
  default = {}
}
