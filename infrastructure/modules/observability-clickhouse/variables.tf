variable "alarms_enabled" {
  description = "Whether the module creates its CloudWatch alarms. False creates none, for an installation whose ops alerts reach no one."
  type        = bool
  default     = true
}

variable "alarm_topic_arn" {
  description = "Ops alerts SNS topic ARN notified when an alarm enters or leaves the ALARM state."
  type        = string
}

variable "ami_id" {
  description = "Optional ARM64 AMI for the ClickHouse node, such as one baked from infrastructure/images/clickhouse. Empty pins the newest Canonical Ubuntu 24.04 ARM64 image at the first apply, and the bootstrap installs the checksum-pinned ClickHouse packages."
  type        = string
  default     = ""

  validation {
    condition     = trimspace(var.ami_id) == "" || can(regex("^ami-[0-9a-f]+$", trimspace(var.ami_id)))
    error_message = "ami_id must be empty or an EC2 AMI ID."
  }
}

variable "backup_retention_in_days" {
  description = "Days native ClickHouse BACKUP objects stay current in S3 and EBS data-volume snapshots are kept by the daily backup association."
  type        = number

  validation {
    condition     = floor(var.backup_retention_in_days) == var.backup_retention_in_days && var.backup_retention_in_days >= 1
    error_message = "backup_retention_in_days must be a positive whole number of days."
  }
}

variable "container_insights_enabled" {
  description = "Whether ECS Container Insights is enabled on the hot-plane cluster."
  type        = bool
}

variable "fargate_spot_enabled" {
  description = "Whether the hot-plane service runs on FARGATE_SPOT instead of FARGATE capacity."
  type        = bool
}

variable "control_table_arn" {
  description = "Control table ARN read for erasure fences and organization existence."
  type        = string
}

variable "control_table_name" {
  description = "Control table name read for erasure fences and organization existence."
  type        = string
}

variable "data_volume_iops" {
  description = "Provisioned gp3 IOPS for the ClickHouse data volume."
  type        = number
  default     = 3000
}

variable "data_volume_size_gib" {
  description = "ClickHouse data-volume capacity in GiB. The volume only grows: a smaller value than the volume's current size keeps the current size."
  type        = number
  default     = 20

  validation {
    condition     = floor(var.data_volume_size_gib) == var.data_volume_size_gib && var.data_volume_size_gib >= 10 && var.data_volume_size_gib <= 16384
    error_message = "data_volume_size_gib must be a whole number of GiB from 10 through 16384."
  }
}

variable "data_volume_throughput" {
  description = "Provisioned gp3 throughput in MiB/s."
  type        = number
  default     = 125
}

variable "deletion_protection_enabled" {
  description = "Whether the data volume is retained with prevent_destroy and a final snapshot, the node has termination protection, the checkpoint table has DynamoDB deletion protection, and the backup bucket refuses force-destroy. Changing this value moves the data volume between protected and unprotected resource addresses."
  type        = bool
}

variable "desired_count" {
  description = "Number of hot-plane ECS writer/query tasks. Phase 3 begins with one."
  type        = number
  default     = 1

  validation {
    condition     = floor(var.desired_count) == var.desired_count && var.desired_count >= 0 && var.desired_count <= 1
    error_message = "desired_count must be zero or one."
  }
}

variable "detailed_monitoring_enabled" {
  description = "Whether EC2 detailed (one-minute) monitoring is enabled on the ClickHouse node."
  type        = bool
}

variable "ecs_exec_enabled" {
  description = "Whether operators may open ECS Exec shells into the hot-plane task; grants the task role the ssmmessages channel actions."
  type        = bool
}

variable "environment" {
  description = "Deployment environment."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must start with a lowercase letter and contain at most 16 lowercase letters, digits, or hyphens."
  }
}

variable "fact_stream_arn" {
  description = "Normalized observability Kinesis stream ARN."
  type        = string
}

variable "hot_plane_image" {
  description = "Immutable ARM64 observability hot-plane image URI."
  type        = string

  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", trimspace(var.hot_plane_image)))
    error_message = "hot_plane_image must use an immutable sha256 digest."
  }
}

variable "instance_type" {
  description = "ARM64 EC2 instance type for ClickHouse. ClickHouse sizes its memory cap from the instance's RAM unless server_memory_bytes is set. A t4g node runs in unlimited credit mode."
  type        = string
  default     = "t4g.medium"

  validation {
    condition     = can(regex("^(t4g\\.(small|medium|large|xlarge|2xlarge)|r7g\\.[a-z0-9]+)$", var.instance_type))
    error_message = "instance_type must be an approved Graviton shape; burstable nodes require t4g.small or larger."
  }
}

variable "log_retention_in_days" {
  description = "CloudWatch log retention for the hot-plane service log group."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a CloudWatch Logs retention value."
  }
}

variable "private_subnet_ids" {
  description = "Private subnets available to the ClickHouse node and Fargate task."
  type        = list(string)

  validation {
    condition     = length(var.private_subnet_ids) > 0
    error_message = "At least one private subnet is required."
  }
}

variable "quarantine_bucket_arn" {
  description = "Encrypted Phase 2 quarantine bucket ARN for malformed hot-writer records."
  type        = string
}

variable "quarantine_bucket_name" {
  description = "Encrypted Phase 2 quarantine bucket name for malformed hot-writer records."
  type        = string
}

variable "root_volume_size_gib" {
  description = "ClickHouse root-volume capacity in GiB. It must be at least the AMI's snapshot size: 8 GiB for Canonical's Ubuntu image and 20 GiB for the infrastructure/images/clickhouse bake."
  type        = number
  default     = 20

  validation {
    condition     = floor(var.root_volume_size_gib) == var.root_volume_size_gib && var.root_volume_size_gib >= 8
    error_message = "root_volume_size_gib must be a whole number of GiB, at least 8."
  }
}

variable "server_memory_bytes" {
  description = "Optional hard ClickHouse server memory cap in bytes. Null lets ClickHouse cap itself at 70 percent of the instance's RAM, so the cap follows the instance type."
  type        = number
  default     = null

  validation {
    condition     = var.server_memory_bytes == null || try(var.server_memory_bytes >= 1000000000, false)
    error_message = "server_memory_bytes must be null or at least 1000000000."
  }
}

variable "tags" {
  description = "Additional tags applied to every resource."
  type        = map(string)
  default     = {}
}

variable "task_size" {
  description = "Fargate CPU units and memory in MiB of the hot-plane writer/API task. 256/512 holds one 10 MiB Kinesis batch and one 10 MiB ClickHouse result with room to spare."
  type = object({
    cpu    = number
    memory = number
  })
  default = { cpu = 256, memory = 512 }

  validation {
    condition = contains([
      "256/512", "256/1024", "256/2048",
      "512/1024", "512/2048", "512/3072", "512/4096",
      "1024/2048", "1024/3072", "1024/4096", "1024/5120", "1024/6144", "1024/7168", "1024/8192",
    ], "${var.task_size.cpu}/${var.task_size.memory}")
    error_message = "task_size must be a Fargate CPU/memory pair from 256/512 through 1024/8192."
  }
}

variable "vpc_cidr" {
  description = "VPC CIDR allowed to reach the authenticated internal hot API and to connect as the ClickHouse ingest and query users."
  type        = string

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be an IPv4 CIDR block."
  }
}

variable "vpc_id" {
  description = "VPC hosting the private ClickHouse hot plane."
  type        = string
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}
