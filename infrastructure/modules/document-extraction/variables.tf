variable "artifact_bucket" {
  description = "S3 bucket containing the bundled document extraction Lambda artifact."
  type        = string

  validation {
    condition     = trimspace(var.artifact_bucket) != ""
    error_message = "artifact_bucket is required."
  }
}

variable "artifact_key" {
  description = "S3 object key for the bundled document extraction Lambda artifact."
  type        = string

  validation {
    condition     = trimspace(var.artifact_key) != ""
    error_message = "artifact_key is required."
  }
}

variable "artifact_version" {
  description = "Immutable S3 object version for the bundled document extraction Lambda artifact."
  type        = string

  validation {
    condition     = trimspace(var.artifact_version) != "" && lower(trimspace(var.artifact_version)) != "null"
    error_message = "artifact_version must pin a non-null immutable S3 object version."
  }
}

variable "environment" {
  description = "Platform environment name."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{0,15}$", var.environment))
    error_message = "environment must be a lowercase name of at most 16 characters."
  }
}

variable "log_retention_in_days" {
  description = "CloudWatch retention for the document extraction Lambda log group."
  type        = number

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_in_days)
    error_message = "log_retention_in_days must be a CloudWatch Logs retention value."
  }
}

variable "network" {
  description = "Private subnets the function runs in and the S3 gateway endpoint prefix list it may reach, or null to run outside a VPC."
  type = object({
    private_subnet_ids = list(string)
    s3_prefix_list_id  = string
    vpc_id             = string
  })
}

variable "ocr_enabled" {
  description = "Whether the function sends PDF pages that have no text layer to Amazon Textract DetectDocumentText. AWS may use those page images to improve its services unless the AWS Organization applies an AI services opt-out policy. Inside a VPC this adds a Textract interface endpoint."
  type        = bool
}

variable "permissions_boundary_arn" {
  description = "Managed policy ARN set as the permissions boundary of every IAM role this module creates. Null sets none."
  type        = string
  default     = null
}

variable "tags" {
  description = "Additional tags applied to document extraction resources."
  type        = map(string)
  default     = {}
}
